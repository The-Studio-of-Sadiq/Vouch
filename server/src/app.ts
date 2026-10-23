import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { openDb } from './db.js';
import { ASSET_LINKS, HOME_PAGE, INVITE_PAGE, PAGE_CSP } from './pages.js';
import type {
  AuthResponse,
  ClientFrame,
  Envelope,
  Group,
  KeyUpload,
  Me,
  PreKeyBundle,
  PreKeyUpload,
  PublicUser,
  ServerFrame,
} from '../../shared/protocol.js';
import { PREKEY_LOW_WATER } from '../../shared/protocol.js';

export interface ServerOptions {
  dbPath: string;
  port: number;
  // Extra browser origins allowed to use the API. For local development only;
  // production allows nothing but the Android app.
  corsOrigins?: string[];
}

// Origins Capacitor serves the bundled UI from inside the native app. Veil has
// no browser version: any other browser origin is refused (see `originAllowed`).
const NATIVE_ORIGINS = ['https://localhost', 'capacitor://localhost'];
const BROWSER_REFUSED = 'Veil only works in the Android app.';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_BODY = 512 * 1024;
const MAX_ENVELOPE = 64 * 1024;

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 64, SCRYPT).toString('base64');
}

function isB64(s: unknown, maxLen = 4096): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= maxLen && /^[A-Za-z0-9+/]+=*$/.test(s);
}

function validPreKey(k: PreKeyUpload) {
  return k && Number.isInteger(k.keyId) && k.keyId > 0 && isB64(k.publicKey, 128);
}

export function createServer(opts: ServerOptions) {
  const db = openDb(opts.dbPath);
  const sockets = new Map<string, Set<WebSocket>>();
  const socketTokens = new WeakMap<WebSocket, string>();
  const loginFailures = new Map<string, { count: number; until: number }>();

  // --- data helpers --------------------------------------------------------

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, name, email FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (id, email, name, pw_hash, pw_salt, created) VALUES (?, ?, ?, ?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)'),
    session: db.prepare('SELECT user_id FROM sessions WHERE token = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    revokeOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ? RETURNING token'),
    identity: db.prepare('SELECT * FROM identities WHERE user_id = ?'),
    upsertIdentity: db.prepare(`
      INSERT INTO identities (user_id, registration_id, identity_key, signed_prekey_id, signed_prekey, signed_prekey_sig, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET registration_id = excluded.registration_id, identity_key = excluded.identity_key,
        signed_prekey_id = excluded.signed_prekey_id, signed_prekey = excluded.signed_prekey,
        signed_prekey_sig = excluded.signed_prekey_sig, updated = excluded.updated`),
    deletePreKeys: db.prepare('DELETE FROM prekeys WHERE user_id = ?'),
    insertPreKey: db.prepare('INSERT OR REPLACE INTO prekeys (user_id, key_id, public_key) VALUES (?, ?, ?)'),
    countPreKeys: db.prepare('SELECT COUNT(*) AS n FROM prekeys WHERE user_id = ?'),
    takePreKey: db.prepare('DELETE FROM prekeys WHERE rowid = (SELECT rowid FROM prekeys WHERE user_id = ? ORDER BY key_id LIMIT 1) RETURNING key_id, public_key'),
    insertGroup: db.prepare('INSERT INTO groups (id, name, owner_id, invite_code, created) VALUES (?, ?, ?, ?, ?)'),
    groupById: db.prepare('SELECT * FROM groups WHERE id = ?'),
    groupByInvite: db.prepare('SELECT * FROM groups WHERE invite_code = ?'),
    myGroups: db.prepare('SELECT g.* FROM groups g JOIN members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.created'),
    groupMembers: db.prepare('SELECT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.joined'),
    insertMember: db.prepare('INSERT OR IGNORE INTO members (group_id, user_id, joined) VALUES (?, ?, ?)'),
    deleteMember: db.prepare('DELETE FROM members WHERE group_id = ? AND user_id = ?'),
    isMember: db.prepare('SELECT 1 FROM members WHERE group_id = ? AND user_id = ?'),
    deleteGroup: db.prepare('DELETE FROM groups WHERE id = ?'),
    sharesGroup: db.prepare(`
      SELECT 1 FROM members a JOIN members b ON a.group_id = b.group_id
      WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`),
    contacts: db.prepare(`
      SELECT DISTINCT b.user_id AS id FROM members a JOIN members b ON a.group_id = b.group_id
      WHERE a.user_id = ? AND b.user_id != ?`),
    insertEnvelope: db.prepare('INSERT INTO envelopes (recipient_id, sender_id, type, body, created) VALUES (?, ?, ?, ?, ?) RETURNING id'),
    pendingEnvelopes: db.prepare('SELECT id, sender_id, type, body, created FROM envelopes WHERE recipient_id = ? ORDER BY id'),
    deleteEnvelope: db.prepare('DELETE FROM envelopes WHERE id = ? AND recipient_id = ?'),
  };

  function tx<T>(fn: () => T): T {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function issueSession(userId: string) {
    const token = randomBytes(32).toString('base64url');
    q.insertSession.run(token, userId, Date.now());
    return token;
  }

  function authUser(token: string | undefined | null): string | null {
    if (!token) return null;
    const row = q.session.get(token) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }

  function groupView(row: any): Group {
    return {
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      inviteCode: row.invite_code,
      members: q.groupMembers.all(row.id) as unknown as PublicUser[],
    };
  }

  // Tells a signed-out device to wipe itself, then drops its connection.
  function revokeSockets(userId: string, tokens: Set<string>) {
    for (const ws of sockets.get(userId) ?? []) {
      if (!tokens.has(socketTokens.get(ws) ?? '')) continue;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'revoked' } satisfies ServerFrame));
      ws.close(4001, 'signed in on another device');
    }
  }

  function push(userId: string, frame: ServerFrame) {
    const data = JSON.stringify(frame);
    for (const ws of sockets.get(userId) ?? []) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  function notifyGroup(groupId: string, extra: string[] = []) {
    const ids = new Set([...(q.groupMembers.all(groupId) as any[]).map((m) => m.id), ...extra]);
    for (const id of ids) push(id, { t: 'group', groupId });
  }

  // --- routes --------------------------------------------------------------

  type Handler = (ctx: { userId: string | null; body: any; params: string[]; token: string | null }) => unknown;
  const routes: { method: string; pattern: RegExp; auth: boolean; handler: Handler }[] = [];
  const route = (method: string, path: string, auth: boolean, handler: Handler) =>
    routes.push({ method, pattern: new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)') + '$'), auth, handler });

  route('GET', '/api/health', false, () => ({ ok: true }));

  route('POST', '/api/register', false, ({ body }) => {
    const email = String(body?.email ?? '').trim().toLowerCase();
    const name = String(body?.name ?? '').trim();
    const password = String(body?.password ?? '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email.');
    if (name.length < 1 || name.length > 40) throw new HttpError(400, 'Name must be 1–40 characters.');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (q.userByEmail.get(email)) throw new HttpError(409, 'An account with that email already exists.');
    const id = randomUUID();
    const salt = randomBytes(16).toString('base64');
    q.insertUser.run(id, email, name, hashPassword(password, salt), salt, Date.now());
    const res: AuthResponse = { token: issueSession(id), user: { id, email, name } };
    return res;
  });

  route('POST', '/api/login', false, ({ body }) => {
    const email = String(body?.email ?? '').trim().toLowerCase();
    const password = String(body?.password ?? '');
    const fail = loginFailures.get(email);
    if (fail && fail.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
    const row = q.userByEmail.get(email) as any;
    const ok =
      row &&
      timingSafeEqual(Buffer.from(hashPassword(password, row.pw_salt), 'base64'), Buffer.from(row.pw_hash, 'base64'));
    if (!ok) {
      const count = (fail?.count ?? 0) + 1;
      loginFailures.set(email, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
      throw new HttpError(401, 'Wrong email or password.');
    }
    loginFailures.delete(email);
    const res: AuthResponse = { token: issueSession(row.id), user: { id: row.id, email: row.email, name: row.name } };
    return res;
  });

  route('POST', '/api/logout', true, ({ token }) => {
    q.deleteSession.run(token);
    return { ok: true };
  });

  route('GET', '/api/me', true, ({ userId }) => {
    const me = q.userById.get(userId) as unknown as Me;
    const identity = q.identity.get(userId) as any;
    return { user: me, identityKey: identity?.identity_key ?? null };
  });

  // Replaces the account's identity (new device / reinstall) and its prekeys.
  // One device per account: a new identity signs every other session out, and
  // those devices wipe their keys and history when told they were revoked.
  route('PUT', '/api/keys', true, ({ userId, body, token }) => {
    const k = body as KeyUpload;
    if (
      !Number.isInteger(k?.registrationId) ||
      !isB64(k.identityKey, 128) ||
      !validPreKey(k.signedPreKey) ||
      !isB64(k.signedPreKey.signature, 256) ||
      !Array.isArray(k.preKeys) ||
      k.preKeys.length > 200 ||
      !k.preKeys.every(validPreKey)
    )
      throw new HttpError(400, 'Malformed key bundle.');
    const prev = q.identity.get(userId) as any;
    const changed = !prev || prev.identity_key !== k.identityKey;
    let revoked: string[] = [];
    tx(() => {
      if (changed) revoked = (q.revokeOtherSessions.all(userId, token) as { token: string }[]).map((r) => r.token);
      q.upsertIdentity.run(
        userId, k.registrationId, k.identityKey, k.signedPreKey.keyId, k.signedPreKey.publicKey, k.signedPreKey.signature, Date.now(),
      );
      if (!prev || prev.identity_key !== k.identityKey) q.deletePreKeys.run(userId);
      for (const p of k.preKeys) q.insertPreKey.run(userId, p.keyId, p.publicKey);
    });
    if (revoked.length) revokeSockets(userId!, new Set(revoked));
    if (prev && changed) {
      for (const c of q.contacts.all(userId, userId) as any[]) push(c.id, { t: 'identity', userId: userId! });
    }
    return { ok: true, revokedSessions: revoked.length };
  });

  route('POST', '/api/keys/prekeys', true, ({ userId, body }) => {
    const keys = body?.preKeys as PreKeyUpload[];
    if (!Array.isArray(keys) || keys.length > 200 || !keys.every(validPreKey)) throw new HttpError(400, 'Malformed prekeys.');
    tx(() => keys.forEach((p) => q.insertPreKey.run(userId, p.keyId, p.publicKey)));
    return { ok: true };
  });

  route('GET', '/api/keys/count', true, ({ userId }) => ({ count: (q.countPreKeys.get(userId) as any).n }));

  // Hands out one one-time prekey per call. Only people who share a group can
  // fetch each other's bundles, so the key directory can't be enumerated.
  route('GET', '/api/keys/:id', true, ({ userId, params: [target] }) => {
    if (!q.sharesGroup.get(userId, target)) throw new HttpError(403, 'You do not share a group with that user.');
    const id = q.identity.get(target) as any;
    if (!id) throw new HttpError(404, 'That user has not set up encryption yet.');
    const pre = q.takePreKey.get(target) as any;
    const bundle: PreKeyBundle = {
      userId: target,
      registrationId: id.registration_id,
      identityKey: id.identity_key,
      signedPreKey: { keyId: id.signed_prekey_id, publicKey: id.signed_prekey, signature: id.signed_prekey_sig },
      preKey: pre ? { keyId: pre.key_id, publicKey: pre.public_key } : undefined,
    };
    const left = (q.countPreKeys.get(target) as any).n;
    if (left < PREKEY_LOW_WATER) push(target, { t: 'prekeys-low' });
    return bundle;
  });

  route('GET', '/api/groups', true, ({ userId }) => (q.myGroups.all(userId) as any[]).map(groupView));

  route('POST', '/api/groups', true, ({ userId, body }) => {
    const name = String(body?.name ?? '').trim();
    if (name.length < 1 || name.length > 60) throw new HttpError(400, 'Group name must be 1–60 characters.');
    const id = randomUUID();
    tx(() => {
      q.insertGroup.run(id, name, userId, randomBytes(9).toString('base64url'), Date.now());
      q.insertMember.run(id, userId, Date.now());
    });
    return groupView(q.groupById.get(id));
  });

  // Preview for an invite link, so the app can ask "Join <name>?" first.
  route('GET', '/api/invites/:code', true, ({ userId, params: [code] }) => {
    const g = q.groupByInvite.get(code) as any;
    if (!g) throw new HttpError(404, 'This invite link is invalid or the group no longer exists.');
    return {
      groupId: g.id,
      name: g.name,
      memberCount: (q.groupMembers.all(g.id) as any[]).length,
      alreadyMember: !!q.isMember.get(g.id, userId),
    };
  });

  route('POST', '/api/groups/join', true, ({ userId, body }) => {
    const g = q.groupByInvite.get(String(body?.inviteCode ?? '').trim()) as any;
    if (!g) throw new HttpError(404, 'No group with that invite code.');
    q.insertMember.run(g.id, userId, Date.now());
    notifyGroup(g.id);
    return groupView(g);
  });

  route('POST', '/api/groups/:id/leave', true, ({ userId, params: [groupId] }) => {
    const g = q.groupById.get(groupId) as any;
    if (!g || !q.isMember.get(groupId, userId)) throw new HttpError(404, 'Group not found.');
    q.deleteMember.run(groupId, userId);
    if ((q.groupMembers.all(groupId) as any[]).length === 0) q.deleteGroup.run(groupId);
    else notifyGroup(groupId, [userId!]);
    return { ok: true };
  });

  route('POST', '/api/groups/:id/remove', true, ({ userId, params: [groupId], body }) => {
    const g = q.groupById.get(groupId) as any;
    if (!g || g.owner_id !== userId) throw new HttpError(403, 'Only the group owner can remove members.');
    const target = String(body?.userId ?? '');
    if (target === userId) throw new HttpError(400, 'Use leave instead.');
    q.deleteMember.run(groupId, target);
    notifyGroup(groupId, [target]);
    return { ok: true };
  });

  // --- http plumbing -------------------------------------------------------

  function bearer(req: IncomingMessage) {
    const h = req.headers.authorization;
    return h?.startsWith('Bearer ') ? h.slice(7) : null;
  }

  async function readBody(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request too large.');
      chunks.push(c);
    }
    if (!size) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
  }

  const allowedOrigins = new Set([...NATIVE_ORIGINS, ...(opts.corsOrigins ?? [])]);
  // Browsers always send Origin on cross-origin and WebSocket requests. The app
  // and non-browser tools send an allowed origin or none at all.
  const originAllowed = (req: IncomingMessage) => !req.headers.origin || allowedOrigins.has(req.headers.origin);

  function sendPage(res: ServerResponse, type: string, body: string) {
    res.writeHead(200, {
      'content-type': type,
      'content-security-policy': PAGE_CSP,
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  const http = createHttpServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      // Auth is a bearer token, never a cookie, so no credentials mode needed.
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT');
      res.setHeader('access-control-max-age', '600');
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path.startsWith('/api/') && !originAllowed(req)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: BROWSER_REFUSED }));
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      if (!path.startsWith('/api/')) {
        if (req.method === 'GET' && path === '/.well-known/assetlinks.json') return sendPage(res, 'application/json', ASSET_LINKS);
        if (req.method === 'GET' && /^\/join\/[A-Za-z0-9_-]+\/?$/.test(path)) return sendPage(res, 'text/html; charset=utf-8', INVITE_PAGE);
        if (req.method === 'GET' && path === '/') return sendPage(res, 'text/html; charset=utf-8', HOME_PAGE);
        throw new HttpError(404, 'Not found.');
      }
      for (const r of routes) {
        const m = r.method === req.method && path.match(r.pattern);
        if (!m) continue;
        const token = bearer(req);
        const userId = authUser(token);
        if (r.auth && !userId) throw new HttpError(401, 'Not signed in.');
        const body = req.method === 'GET' ? undefined : await readBody(req);
        const out = await r.handler({ userId, body, params: m.slice(1).map(decodeURIComponent), token });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(out));
        return;
      }
      throw new HttpError(404, 'Not found.');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : 'Server error.' }));
    }
  });

  // --- websocket relay -----------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    const userId = url.pathname === '/ws' ? authUser(token) : null;
    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      socketTokens.set(ws, token!);
      onSocket(ws, userId);
    });
  });

  function onSocket(ws: WebSocket, userId: string) {
    let set = sockets.get(userId);
    if (!set) sockets.set(userId, (set = new Set()));
    set.add(ws);

    for (const row of q.pendingEnvelopes.all(userId) as any[]) {
      const envelope: Envelope = { id: row.id, from: row.sender_id, type: row.type, body: row.body, at: row.created };
      ws.send(JSON.stringify({ t: 'envelope', envelope } satisfies ServerFrame));
    }

    ws.on('message', (raw) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame.t === 'ack' && Array.isArray(frame.ids)) {
        for (const id of frame.ids) if (Number.isInteger(id)) q.deleteEnvelope.run(id, userId);
      } else if (frame.t === 'send' && Array.isArray(frame.envelopes)) {
        const rejected: string[] = [];
        const now = Date.now();
        for (const e of frame.envelopes) {
          const ok =
            typeof e?.to === 'string' &&
            (e.type === 1 || e.type === 3) &&
            isB64(e.body, MAX_ENVELOPE) &&
            e.to !== userId &&
            q.sharesGroup.get(userId, e.to);
          if (!ok) {
            rejected.push(String(e?.to));
            continue;
          }
          const { id } = q.insertEnvelope.get(e.to, userId, e.type, e.body, now) as { id: number };
          push(e.to, { t: 'envelope', envelope: { id, from: userId, type: e.type, body: e.body, at: now } });
        }
        ws.send(JSON.stringify({ t: 'sent', ref: String(frame.ref), rejected } satisfies ServerFrame));
      }
    });

    ws.on('close', () => {
      set!.delete(ws);
      if (!set!.size) sockets.delete(userId);
    });
  }

  return {
    http,
    listen: () =>
      new Promise<number>((resolve) => {
        http.listen(opts.port, () => {
          const addr = http.address();
          resolve(typeof addr === 'object' && addr ? addr.port : opts.port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        http.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}
