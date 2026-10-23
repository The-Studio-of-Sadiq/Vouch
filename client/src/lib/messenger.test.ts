import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../../server/src/app';
import type { AuthResponse } from '../../../shared/protocol';
import { FingerprintGenerator, KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import { chunkWords } from './chunks';
import { parseInvite } from './invite';
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

describe('parseInvite', () => {
  it('accepts links and bare codes, rejects junk', () => {
    expect(parseInvite('https://veil-secure-chat.fly.dev/join/cNGCfNPRMgLk')).toBe('cNGCfNPRMgLk');
    expect(parseInvite('  Join "x" on Veil: https://a.b/join/abc_DEF-123 ')).toBe('abc_DEF-123');
    expect(parseInvite('cNGCfNPRMgLk')).toBe('cNGCfNPRMgLk');
    expect(parseInvite('hello there')).toBeNull();
    expect(parseInvite('')).toBeNull();
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
    const preview = await carol.api<any>('GET', `/api/invites/${group.inviteCode}`);
    expect(preview).toMatchObject({ groupId: group.id, name: 'Secret org', memberCount: 2, alreadyMember: false });
    await expect(carol.api('GET', '/api/invites/not-a-real-code')).rejects.toThrow(/invalid/);
    await carol.joinGroup(group.inviteCode);
    expect((await carol.api<any>('GET', `/api/invites/${group.inviteCode}`)).alreadyMember).toBe(true);
    await waitFor(() => alice.groups[0]?.members.length === 3);

    const text = 'the eagle lands at midnight near the old pier bring nothing';
    await alice.sendText(group.id, text);

    await waitFor(() => bob.getMessages(group.id).length === 1 && carol.getMessages(group.id).length === 1);
    const msg = bob.getMessages(group.id)[0];
    expect(msg.chunks).toEqual(chunkWords(text));
    expect(msg.senderId).toBe(alice.user.id);

    // Bob reveals chunks 0 and 2; everyone's roster should learn exactly that.
    // Bob opens part 0 twice (reading it fully the second time) and fully
    // reads part 2 once; everyone's roster should learn exactly that.
    await bob.recordView(group.id, msg.id, 0, false);
    await bob.recordView(group.id, msg.id, 0, true);
    await bob.recordView(group.id, msg.id, 2, true);
    const bobOn = (m: typeof alice) => m.getReads(group.id)[msg.id]?.[bob.user.id] ?? {};
    await waitFor(() => bobOn(alice)[0]?.opens === 2 && !!bobOn(alice)[2]?.read);
    await waitFor(() => bobOn(carol)[0]?.opens === 2 && !!bobOn(carol)[2]?.read);
    expect(bobOn(alice)[0]).toMatchObject({ opens: 2, read: true });
    expect(bobOn(alice)[2]).toMatchObject({ opens: 1, read: true });
    expect(bobOn(alice)[1]).toBeUndefined();
    expect(bobOn(alice)[0].readAt).toBeGreaterThanOrEqual(bobOn(alice)[0].first);

    // An open that doesn't reveal everything counts, but isn't a read.
    await carol.recordView(group.id, msg.id, 1, false);
    await waitFor(() => alice.getReads(group.id)[msg.id]?.[carol.user.id]?.[1]?.opens === 1);
    expect(alice.getReads(group.id)[msg.id][carol.user.id][1].read).toBe(false);

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
