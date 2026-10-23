import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createServer } from '../../../server/src/app';
import type { AuthResponse } from '../../../shared/protocol';
import { memoryKV } from './kv';
import { Messenger } from './messenger';

// Security policies: Android-only (no browser clients) and one device per account.

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

async function auth(path: 'register' | 'login', email: string, name = 'x') {
  const res = await fetch(`${base}/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name, password: 'correct horse battery' }),
  });
  return (await res.json()) as AuthResponse;
}

async function device(a: AuthResponse, onRevoked?: () => void) {
  const m = new Messenger({ baseUrl: base, wsUrl: base.replace('http', 'ws') + '/ws', token: a.token, user: a.user, kv: memoryKV(), onRevoked });
  clients.push(m);
  await m.start();
  await waitFor(() => m.connected);
  return m;
}

function wsOpens(origin?: string, token = 'x') {
  return new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`, origin ? { headers: { origin } } : {});
    ws.on('open', () => (ws.close(), resolve(true)));
    ws.on('error', () => resolve(false));
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'secure-chat-policy-'));
  server = createServer({ dbPath: join(dir, 'test.db'), port: 0 });
  base = `http://localhost:${await server.listen()}`;
});

afterAll(async () => {
  clients.forEach((c) => c.stop());
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Android-only', () => {
  it('refuses API and WebSocket access from browser origins', async () => {
    const health = (origin?: string) => fetch(`${base}/api/health`, { headers: origin ? { origin } : {} }).then((r) => r.status);
    expect(await health('https://evil.example')).toBe(403);
    expect(await health('http://localhost:5173')).toBe(403);
    expect(await health('https://localhost')).toBe(200); // the Android app's WebView
    expect(await health()).toBe(200); // non-browser clients

    const a = await auth('register', 'ws-origin@example.test');
    expect(await wsOpens('https://evil.example', a.token)).toBe(false);
    expect(await wsOpens('https://localhost', a.token)).toBe(true);
  });

  it('serves no web client, only the invite landing page and App Links file', async () => {
    const get = (p: string) => fetch(base + p);
    for (const p of ['/index.html', '/assets/index.js', '/login']) expect((await get(p)).status).toBe(404);
    const invite = await get('/join/abcDEF123');
    expect(invite.status).toBe(200);
    expect(await invite.text()).toContain('Android app');
    const links = await (await get('/.well-known/assetlinks.json')).json();
    expect(links[0].target.package_name).toBe('app.veil.chat');
  });
});

describe('one device per account', () => {
  it('signs the old device out when the account signs in on a new one', async () => {
    const first = await auth('register', 'one-device@example.test', 'Dana');
    let revoked = 0;
    const phone1 = await device(first, () => revoked++);

    const bob = await device(await auth('register', 'bob-od@example.test', 'Bob'));
    const g = await phone1.createGroup('Pair');
    await bob.joinGroup(g.inviteCode);
    await phone1.refreshGroups();

    // Same account, new phone: fresh keys (empty storage) upload a new identity.
    const second = await auth('login', 'one-device@example.test');
    const phone2 = await device(second);

    await waitFor(() => revoked === 1);
    expect((await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${first.token}` } })).status).toBe(401);
    expect(await wsOpens(undefined, first.token)).toBe(false);

    // Contacts are warned, and messages now reach only the new phone.
    await waitFor(() => bob.identityWarnings.has(second.user.id));
    await bob.refreshGroups();
    await bob.sendText(g.id, 'only the current phone can read this');
    await waitFor(() => phone2.getMessages(g.id).length === 1);
    expect(phone1.getMessages(g.id)).toHaveLength(0);
  });

  it('keeps the same device signed in when it re-uploads the same identity', async () => {
    const a = await auth('register', 'same-device@example.test');
    let revoked = 0;
    const kv = memoryKV();
    const m1 = new Messenger({ baseUrl: base, wsUrl: base.replace('http', 'ws') + '/ws', token: a.token, user: a.user, kv, onRevoked: () => revoked++ });
    clients.push(m1);
    await m1.start();
    // Signing in again on the same phone reuses its stored identity.
    const again = await auth('login', 'same-device@example.test');
    const m2 = new Messenger({ baseUrl: base, wsUrl: base.replace('http', 'ws') + '/ws', token: again.token, user: again.user, kv });
    clients.push(m2);
    await m2.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(revoked).toBe(0);
  });
});
