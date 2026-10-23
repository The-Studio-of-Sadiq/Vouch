// End-to-end smoke test against a deployed server:
//   npx tsx scripts/smoke.ts https://veil-secure-chat.fly.dev
// Registers two throwaway accounts, exchanges an encrypted message and a read
// receipt over the real relay, and exits non-zero on failure.
import type { AuthResponse } from '../../shared/protocol';
import { memoryKV } from '../src/lib/kv';
import { Messenger } from '../src/lib/messenger';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!base) throw new Error('usage: smoke.ts <server url>');

async function waitFor(cond: () => boolean, what: string, ms = 20_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function account(name: string) {
  const tag = crypto.randomUUID().slice(0, 8);
  const res = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `smoke-${name}-${tag}@example.test`, name: `smoke-${name}`, password: crypto.randomUUID() }),
  });
  if (!res.ok) throw new Error(`register ${name}: ${res.status} ${await res.text()}`);
  const auth = (await res.json()) as AuthResponse;
  const m = new Messenger({ baseUrl: base, wsUrl: base.replace(/^http/, 'ws') + '/ws', token: auth.token, user: auth.user, kv: memoryKV() });
  await m.start();
  await waitFor(() => m.connected, `${name} websocket`);
  return m;
}

const t0 = Date.now();
const a = await account('a');
const b = await account('b');
const g = await a.createGroup('smoke test');
await b.joinGroup(g.inviteCode);
await waitFor(() => a.groups.find((x) => x.id === g.id)?.members.length === 2, 'membership');
await a.sendText(g.id, 'smoke test message over the deployed relay');
await waitFor(() => b.getMessages(g.id).length === 1, 'message delivery');
const msg = b.getMessages(g.id)[0];
await b.markRead(g.id, msg.id, 0);
await waitFor(() => !!a.getReads(g.id)[msg.id]?.[b.user.id]?.[0], 'read receipt');
const same = (await a.safetyNumber(b.user.id)) === (await b.safetyNumber(a.user.id));
await a.leaveGroup(g.id);
await b.leaveGroup(g.id);
a.stop();
b.stop();
console.log(`OK in ${Date.now() - t0} ms: decrypted "${msg.chunks.join(' ')}", receipt delivered, safety numbers match=${same}`);
if (!same) process.exit(1);
