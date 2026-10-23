import {
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
  type KeyPairType,
} from '@privacyresearch/libsignal-protocol-typescript';
import type {
  Envelope,
  Group,
  KeyUpload,
  Me,
  OutgoingEnvelope,
  PreKeyBundle,
  PreKeyUpload,
  ServerFrame,
} from '../../../shared/protocol';
import { PREKEY_BATCH, PREKEY_LOW_WATER } from '../../../shared/protocol';
import { b64ToBuf, bufToB64, fromUtf8, utf8 } from './bytes';
import { chunkWords } from './chunks';
import { safetyNumber } from './fingerprint';
import type { KV } from './kv';
import { SignalStore } from './signal-store';

const DEVICE_ID = 1;
const RECEIPT_FLUSH_MS = 400;

export interface ChatMessage {
  id: string;
  groupId: string;
  senderId: string;
  chunks: string[];
  sentAt: number;
}

// What one member did with one part of a message.
export interface PartRead {
  opens: number; // how many times they held it open
  read: boolean; // whether they ever revealed every character of it
  first: number; // first opened
  last: number; // last opened
  readAt?: number; // first time it was fully read
}

// msgId -> userId -> chunk index -> activity
export type GroupReads = Record<string, Record<string, Record<number, PartRead>>>;

// Older receipts and stored data held only the time a part was first read.
function normalize(reads: Record<string, Record<string, Record<number, PartRead | number>>>): GroupReads {
  for (const byUser of Object.values(reads))
    for (const parts of Object.values(byUser))
      for (const [i, v] of Object.entries(parts))
        if (typeof v === 'number') parts[Number(i)] = { opens: 1, read: true, first: v, last: v, readAt: v };
  return reads as GroupReads;
}

function merge(into: PartRead | undefined, from: PartRead): PartRead {
  if (!into) return { ...from };
  const readAt = [into.readAt, from.readAt].filter((x): x is number => typeof x === 'number');
  return {
    opens: Math.max(into.opens, from.opens),
    read: into.read || from.read,
    first: Math.min(into.first, from.first),
    last: Math.max(into.last, from.last),
    readAt: readAt.length ? Math.min(...readAt) : undefined,
  };
}

interface PartView extends PartRead {
  i: number;
}

// The plaintext inside every Signal envelope. The server never sees this.
type Payload =
  | { v: 1; kind: 'msg'; groupId: string; id: string; chunks: string[]; sentAt: number }
  // `chunks` lists fully read parts (what 1.2 and older understand); `views`
  // carries the reader's full, absolute activity per part.
  | { v: 1; kind: 'read'; groupId: string; msgId: string; chunks: number[]; views?: PartView[]; at: number };

interface SignedPreKeyRecord {
  keyId: number;
  publicKey: string;
  signature: string;
}

export interface MessengerOptions {
  baseUrl: string;
  wsUrl: string;
  token: string;
  user: Me;
  kv: KV;
  // Called when the server signed this device out because the account signed
  // in on another device. The caller must wipe local data.
  onRevoked?: () => void;
}

export class Messenger {
  readonly user: Me;
  readonly store: SignalStore;
  groups: Group[] = [];
  connected = false;
  identityWarnings = new Set<string>();

  private kv: KV;
  private messages = new Map<string, ChatMessage[]>();
  private reads = new Map<string, GroupReads>();
  private listeners = new Set<() => void>();
  private ws?: WebSocket;
  private stopped = false;
  private retry = 0;
  private inbox: Promise<void> = Promise.resolve();
  private pendingSends = new Map<string, (rejected: string[]) => void>();
  private pendingReceipts = new Map<string, { groupId: string; parts: Set<number> }>();
  private receiptTimer?: ReturnType<typeof setTimeout>;

  constructor(private opts: MessengerOptions) {
    this.user = opts.user;
    this.kv = opts.kv;
    this.store = new SignalStore(opts.kv);
  }

  // --- lifecycle -----------------------------------------------------------

  async start() {
    this.identityWarnings = new Set((await this.kv.get<string[]>('identityWarnings')) ?? []);
    await this.ensureKeys();
    await this.refreshGroups();
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
    clearTimeout(this.receiptTimer);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.opts.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data as T;
  }

  // --- keys ----------------------------------------------------------------

  // Generates this device's Signal identity on first run and keeps the server's
  // copy of the public bundle in sync (single active device per account).
  private async ensureKeys() {
    const { identityKey } = await this.api<{ identityKey: string | null }>('GET', '/api/me');
    let identity = await this.store.getIdentityKeyPair();
    let signed = await this.kv.get<SignedPreKeyRecord>('signedPreKeyPublic');

    if (!identity || !signed) {
      identity = await KeyHelper.generateIdentityKeyPair();
      await this.store.setLocalIdentity(identity, KeyHelper.generateRegistrationId());
      const spk = await KeyHelper.generateSignedPreKey(identity, 1);
      await this.store.storeSignedPreKey(spk.keyId, spk.keyPair);
      signed = { keyId: spk.keyId, publicKey: bufToB64(spk.keyPair.pubKey), signature: bufToB64(spk.signature) };
      await this.kv.set('signedPreKeyPublic', signed);
    }

    if (identityKey !== bufToB64(identity.pubKey)) {
      const upload: KeyUpload = {
        registrationId: (await this.store.getLocalRegistrationId())!,
        identityKey: bufToB64(identity.pubKey),
        signedPreKey: signed,
        preKeys: await this.generatePreKeys(PREKEY_BATCH),
      };
      await this.api('PUT', '/api/keys', upload);
    } else {
      await this.replenishPreKeys();
    }
  }

  private async generatePreKeys(n: number): Promise<PreKeyUpload[]> {
    let next = (await this.kv.get<number>('nextPreKeyId')) ?? 1;
    const out: PreKeyUpload[] = [];
    for (let i = 0; i < n; i++, next++) {
      const pk = await KeyHelper.generatePreKey(next);
      await this.store.storePreKey(pk.keyId, pk.keyPair);
      out.push({ keyId: pk.keyId, publicKey: bufToB64(pk.keyPair.pubKey) });
    }
    await this.kv.set('nextPreKeyId', next);
    return out;
  }

  private async replenishPreKeys() {
    const { count } = await this.api<{ count: number }>('GET', '/api/keys/count');
    if (count < PREKEY_LOW_WATER) {
      await this.api('POST', '/api/keys/prekeys', { preKeys: await this.generatePreKeys(PREKEY_BATCH - count) });
    }
  }

  private address(userId: string) {
    return new SignalProtocolAddress(userId, DEVICE_ID);
  }

  private async acceptNewIdentity(userId: string) {
    await this.store.forgetIdentity(userId);
    await this.store.removeSession(this.address(userId).toString());
    this.identityWarnings.add(userId);
    await this.kv.set('identityWarnings', [...this.identityWarnings]);
    this.emit();
  }

  async dismissIdentityWarning(userId: string) {
    this.identityWarnings.delete(userId);
    await this.kv.set('identityWarnings', [...this.identityWarnings]);
    this.emit();
  }

  // X3DH: fetch the peer's prekey bundle and start a Double Ratchet session.
  private async ensureSession(userId: string) {
    const addr = this.address(userId);
    if (await new SessionCipher(this.store, addr).hasOpenSession()) return;
    const b = await this.api<PreKeyBundle>('GET', `/api/keys/${encodeURIComponent(userId)}`);
    const known = await this.store.loadIdentity(userId);
    if (known && bufToB64(known) !== b.identityKey) await this.acceptNewIdentity(userId);
    await new SessionBuilder(this.store, addr).processPreKey({
      registrationId: b.registrationId,
      identityKey: b64ToBuf(b.identityKey),
      signedPreKey: {
        keyId: b.signedPreKey.keyId,
        publicKey: b64ToBuf(b.signedPreKey.publicKey),
        signature: b64ToBuf(b.signedPreKey.signature),
      },
      preKey: b.preKey && { keyId: b.preKey.keyId, publicKey: b64ToBuf(b.preKey.publicKey) },
    });
  }

  async safetyNumber(userId: string): Promise<string> {
    await this.ensureSession(userId);
    const mine = (await this.store.getIdentityKeyPair()) as KeyPairType;
    const theirs = await this.store.loadIdentity(userId);
    if (!theirs) throw new Error('No identity key for that user yet.');
    return safetyNumber(this.user.id, mine.pubKey, userId, theirs);
  }

  // --- groups --------------------------------------------------------------

  async refreshGroups() {
    this.groups = await this.api<Group[]>('GET', '/api/groups');
    await Promise.all(this.groups.map((g) => this.loadGroup(g.id)));
    this.emit();
  }

  private async loadGroup(groupId: string) {
    if (!this.messages.has(groupId)) this.messages.set(groupId, (await this.kv.get(`messages:${groupId}`)) ?? []);
    if (!this.reads.has(groupId)) this.reads.set(groupId, normalize((await this.kv.get(`reads:${groupId}`)) ?? {}));
  }

  async createGroup(name: string) {
    const g = await this.api<Group>('POST', '/api/groups', { name });
    await this.refreshGroups();
    return g;
  }

  async joinGroup(inviteCode: string) {
    const g = await this.api<Group>('POST', '/api/groups/join', { inviteCode });
    await this.refreshGroups();
    return g;
  }

  async leaveGroup(groupId: string) {
    await this.api('POST', `/api/groups/${groupId}/leave`);
    await this.refreshGroups();
  }

  async removeMember(groupId: string, userId: string) {
    await this.api('POST', `/api/groups/${groupId}/remove`, { userId });
    await this.refreshGroups();
  }

  getMessages(groupId: string) {
    return this.messages.get(groupId) ?? [];
  }

  getReads(groupId: string) {
    return this.reads.get(groupId) ?? {};
  }

  memberName(userId: string) {
    for (const g of this.groups) for (const m of g.members) if (m.id === userId) return m.name;
    return 'Former member';
  }

  // --- sending -------------------------------------------------------------

  async sendText(groupId: string, text: string) {
    const chunks = chunkWords(text);
    if (!chunks.length) return;
    const msg: ChatMessage = { id: crypto.randomUUID(), groupId, senderId: this.user.id, chunks, sentAt: Date.now() };
    await this.storeMessage(msg);
    await this.broadcast(groupId, { v: 1, kind: 'msg', groupId, id: msg.id, chunks, sentAt: msg.sentAt });
  }

  // Records that this user held a part open (`full` if they revealed all of
  // it). Receipts are batched briefly, then sent end-to-end encrypted to every
  // member like any other message, so everyone's roster stays in sync.
  async recordView(groupId: string, msgId: string, chunk: number, full: boolean) {
    const now = Date.now();
    const prev = this.getReads(groupId)[msgId]?.[this.user.id]?.[chunk];
    const next: PartRead = {
      opens: (prev?.opens ?? 0) + 1,
      read: !!prev?.read || full,
      first: prev?.first ?? now,
      last: now,
      readAt: prev?.readAt ?? (full ? now : undefined),
    };
    await this.applyReads(groupId, msgId, this.user.id, { [chunk]: next });
    const pending = this.pendingReceipts.get(msgId) ?? { groupId, parts: new Set() };
    pending.parts.add(chunk);
    this.pendingReceipts.set(msgId, pending);
    clearTimeout(this.receiptTimer);
    this.receiptTimer = setTimeout(() => void this.flushReceipts(), RECEIPT_FLUSH_MS);
  }

  async flushReceipts() {
    const batch = [...this.pendingReceipts];
    this.pendingReceipts.clear();
    for (const [msgId, { groupId, parts }] of batch) {
      const mine = this.getReads(groupId)[msgId]?.[this.user.id] ?? {};
      const views = [...parts].map((i) => ({ i, ...mine[i] }));
      const chunks = Object.entries(mine)
        .filter(([, v]) => v.read)
        .map(([i]) => Number(i));
      await this.broadcast(groupId, { v: 1, kind: 'read', groupId, msgId, chunks, views, at: Date.now() }).catch((e) =>
        console.warn('receipt failed', e),
      );
    }
  }

  // Pairwise fan-out: one Signal ciphertext per recipient.
  private async broadcast(groupId: string, payload: Payload) {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) throw new Error('Unknown group');
    const plaintext = utf8(JSON.stringify(payload));
    const envelopes: OutgoingEnvelope[] = [];
    for (const m of group.members) {
      if (m.id === this.user.id) continue;
      try {
        await this.ensureSession(m.id);
        const ct = await new SessionCipher(this.store, this.address(m.id)).encrypt(plaintext);
        envelopes.push({ to: m.id, type: ct.type, body: btoa(ct.body!) });
      } catch (e) {
        console.warn(`could not encrypt for ${m.name}`, e);
      }
    }
    if (envelopes.length) await this.sendFrame(envelopes);
  }

  private sendFrame(envelopes: OutgoingEnvelope[]) {
    return new Promise<string[]>((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const ref = crypto.randomUUID();
      this.pendingSends.set(ref, resolve);
      this.ws.send(JSON.stringify({ t: 'send', ref, envelopes }));
    });
  }

  // --- receiving -----------------------------------------------------------

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(`${this.opts.wsUrl}?token=${encodeURIComponent(this.opts.token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      this.emit();
    };
    ws.onclose = (ev) => {
      this.connected = false;
      this.emit();
      if (this.stopped) return;
      if (ev.code === 4001) return this.revoked();
      setTimeout(() => void this.reconnect(), Math.min(15_000, 500 * 2 ** this.retry++));
    };
    ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as ServerFrame;
      // Signal sessions are stateful, so frames are processed strictly in order.
      this.inbox = this.inbox.then(() => this.onFrame(frame)).catch((e) => console.error(e));
    };
  }

  // A device that was offline when it got revoked finds out on reconnect: its
  // token no longer works.
  private async reconnect() {
    if (this.stopped) return;
    try {
      await this.api('GET', '/api/me');
    } catch (e) {
      if (/not signed in/i.test((e as Error).message)) return this.revoked();
    }
    this.connect();
  }

  private revoked() {
    if (this.stopped) return;
    this.stop();
    this.opts.onRevoked?.();
  }

  private async onFrame(frame: ServerFrame) {
    switch (frame.t) {
      case 'envelope':
        await this.onEnvelope(frame.envelope);
        this.ws?.send(JSON.stringify({ t: 'ack', ids: [frame.envelope.id] }));
        break;
      case 'sent':
        this.pendingSends.get(frame.ref)?.(frame.rejected);
        this.pendingSends.delete(frame.ref);
        break;
      case 'group':
        await this.refreshGroups();
        break;
      case 'identity':
        await this.acceptNewIdentity(frame.userId);
        break;
      case 'revoked':
        this.revoked();
        break;
      case 'prekeys-low':
        await this.replenishPreKeys();
        break;
    }
  }

  private async decrypt(env: Envelope): Promise<ArrayBuffer> {
    const cipher = new SessionCipher(this.store, this.address(env.from));
    const body = atob(env.body);
    return env.type === 3 ? cipher.decryptPreKeyWhisperMessage(body, 'binary') : cipher.decryptWhisperMessage(body, 'binary');
  }

  private async onEnvelope(env: Envelope) {
    let plaintext: ArrayBuffer;
    try {
      plaintext = await this.decrypt(env);
    } catch (e) {
      // A new PreKey message from someone whose identity changed (reinstall or
      // new device). Accept it, as Signal does, but flag the safety number.
      if (env.type === 3 && /identity key/i.test(String(e))) {
        await this.acceptNewIdentity(env.from);
        plaintext = await this.decrypt(env);
      } else {
        console.warn('dropping undecryptable envelope', e);
        return;
      }
    }

    let p: Payload;
    try {
      p = JSON.parse(fromUtf8(plaintext));
    } catch {
      return;
    }
    let group = this.groups.find((g) => g.id === p.groupId);
    if (!group) {
      await this.refreshGroups();
      group = this.groups.find((g) => g.id === p.groupId);
    }
    // The sender must be a member of the group the payload claims to be for.
    if (!group || !group.members.some((m) => m.id === env.from)) return;

    if (p.kind === 'msg' && Array.isArray(p.chunks) && p.chunks.every((c) => typeof c === 'string')) {
      await this.storeMessage({ id: String(p.id), groupId: group.id, senderId: env.from, chunks: p.chunks, sentAt: Number(p.sentAt) });
    } else if (p.kind === 'read') {
      const msg = this.getMessages(group.id).find((m) => m.id === p.msgId);
      const okIndex = (c: unknown): c is number => Number.isInteger(c) && (c as number) >= 0 && (!msg || (c as number) < msg.chunks.length);
      const at = Number(p.at) || Date.now();
      const parts: Record<number, PartRead> = {};
      if (Array.isArray(p.views)) {
        for (const v of p.views) {
          if (!okIndex(v?.i) || !Number.isInteger(v.opens) || v.opens < 1 || v.opens > 1_000_000) continue;
          const first = Number(v.first) || at;
          parts[v.i] = { opens: v.opens, read: !!v.read, first, last: Math.max(first, Number(v.last) || at), readAt: v.read ? Number(v.readAt) || at : undefined };
        }
      } else if (Array.isArray(p.chunks)) {
        // Receipt from an older version: it only says which parts were read.
        for (const c of p.chunks) if (okIndex(c)) parts[c] = { opens: 1, read: true, first: at, last: at, readAt: at };
      }
      if (Object.keys(parts).length) await this.applyReads(group.id, String(p.msgId), env.from, parts);
    }
  }

  private async storeMessage(msg: ChatMessage) {
    await this.loadGroup(msg.groupId);
    const list = this.messages.get(msg.groupId)!;
    if (list.some((m) => m.id === msg.id)) return;
    list.push(msg);
    list.sort((a, b) => a.sentAt - b.sentAt);
    await this.kv.set(`messages:${msg.groupId}`, list);
    this.emit();
  }

  private async applyReads(groupId: string, msgId: string, userId: string, parts: Record<number, PartRead>) {
    await this.loadGroup(groupId);
    const reads = this.reads.get(groupId)!;
    const byUser = ((reads[msgId] ??= {})[userId] ??= {});
    for (const [i, v] of Object.entries(parts)) byUser[Number(i)] = merge(byUser[Number(i)], v);
    // Replace the object so React consumers see a new reference.
    this.reads.set(groupId, { ...reads });
    await this.kv.set(`reads:${groupId}`, reads);
    this.emit();
  }
}
