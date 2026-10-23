import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../../server/src/app';
import type { AuthResponse } from '../../../shared/protocol';
import { FingerprintGenerator, KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import { chunkWords } from './chunks';
import { safetyNumber } from './fingerprint';
import { memoryKV } from './kv';
import { Messenger } from './messenger';

let server: ReturnType<typeof createServer>;
let base = '';
let dir = '';
const clients: Messenger[] = [];

async function waitFor(cond: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function signUp(name: string, connect = true) {
  const res = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@example.test`, name, password: 'correct horse battery' }),
  });
  const auth = (await res.json()) as AuthResponse;
  const m = new Messenger({ baseUrl: base, wsUrl: base.replace('http', 'ws') + '/ws', token: auth.token, user: auth.user, kv: memoryKV() });
  clients.push(m);
  if (connect) {
    await m.start();
    await waitFor(() => m.connected);
  }
  return m;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'secure-chat-'));
  server = createServer({ dbPath: join(dir, 'test.db'), port: 0 });
  base = `http://localhost:${await server.listen()}`;
});

afterAll(async () => {
  clients.forEach((c) => c.stop());
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('chunkWords', () => {
  it('splits into fixed word chunks', () => {
    expect(chunkWords('one two three four five six seven eight nine', 4)).toEqual([
      'one two three four',
      'five six seven eight',
      'nine',
    ]);
    expect(chunkWords('   ')).toEqual([]);
  });
});

describe('safetyNumber', () => {
  it('matches the library fingerprint generator', async () => {
    const a = await KeyHelper.generateIdentityKeyPair();
    const b = await KeyHelper.generateIdentityKeyPair();
    const expected = await new FingerprintGenerator(50).createFor('alice-id', a.pubKey, 'bob-id', b.pubKey);
    expect(await safetyNumber('alice-id', a.pubKey, 'bob-id', b.pubKey, 50)).toBe(expected);
    expect(expected).toMatch(/^\d{60}$/);
  });
});

describe('end-to-end group chat', () => {
  it('delivers encrypted messages and per-chunk read receipts to every member', async () => {
    const alice = await signUp('alice');
    const bob = await signUp('bob');
    const carol = await signUp('carol');

    const group = await alice.createGroup('Secret org');
    await bob.joinGroup(group.inviteCode);
    await carol.joinGroup(group.inviteCode);
    await waitFor(() => alice.groups[0]?.members.length === 3);

    const text = 'the eagle lands at midnight near the old pier bring nothing';
    await alice.sendText(group.id, text);

    await waitFor(() => bob.getMessages(group.id).length === 1 && carol.getMessages(group.id).length === 1);
    const msg = bob.getMessages(group.id)[0];
    expect(msg.chunks).toEqual(chunkWords(text));
    expect(msg.senderId).toBe(alice.user.id);

    // Bob reveals chunks 0 and 2; everyone's roster should learn exactly that.
    await bob.markRead(group.id, msg.id, 0);
    await bob.markRead(group.id, msg.id, 2);
    await waitFor(() => Object.keys(alice.getReads(group.id)[msg.id]?.[bob.user.id] ?? {}).length === 2);
    await waitFor(() => Object.keys(carol.getReads(group.id)[msg.id]?.[bob.user.id] ?? {}).length === 2);
    expect(Object.keys(alice.getReads(group.id)[msg.id][bob.user.id]).map(Number).sort()).toEqual([0, 2]);

    // Replies ratchet forward in the other direction too.
    await carol.sendText(group.id, 'copy that');
    await waitFor(() => alice.getMessages(group.id).length === 2 && bob.getMessages(group.id).length === 2);

    // Both sides derive the same safety number.
    expect(await alice.safetyNumber(bob.user.id)).toBe(await bob.safetyNumber(alice.user.id));
  });

  it('stores only ciphertext for offline recipients', async () => {
    const erin = await signUp('erin');
    const dave = await signUp('dave');
    const group = await erin.createGroup('Offline test');
    await dave.joinGroup(group.inviteCode);
    dave.stop();
    await waitFor(() => !dave.connected);
    await erin.refreshGroups();

    const secret = 'plaintext should never touch the server disk';
    await erin.sendText(group.id, secret);

    const db = new DatabaseSync(join(dir, 'test.db'), { readOnly: true });
    const rows = db.prepare('SELECT body FROM envelopes WHERE recipient_id = ?').all(dave.user.id) as { body: string }[];
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    for (const { body } of rows) {
      expect(body).not.toContain('plaintext');
      expect(atob(body)).not.toContain('plaintext');
    }
  });
});
