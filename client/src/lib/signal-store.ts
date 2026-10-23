import { Direction, type KeyPairType, type StorageType } from '@privacyresearch/libsignal-protocol-typescript';
import type { KV } from './kv';
import { b64ToBuf, bufToB64, equalBuf } from './bytes';

type StoredPair = { pub: string; priv: string };

const toStored = (k: KeyPairType): StoredPair => ({ pub: bufToB64(k.pubKey), priv: bufToB64(k.privKey) });
const fromStored = (s: StoredPair | undefined): KeyPairType | undefined =>
  s && { pubKey: b64ToBuf(s.pub), privKey: b64ToBuf(s.priv) };

// Addresses look like "<userId>.<deviceId>"; identities are tracked per user.
const userOf = (address: string) => address.split('.')[0];

// Persists Signal protocol state (identity, prekeys, ratchet sessions) in a KV.
export class SignalStore implements StorageType {
  constructor(private kv: KV) {}

  async getIdentityKeyPair() {
    return fromStored(await this.kv.get<StoredPair>('identityKey'));
  }

  async getLocalRegistrationId() {
    return this.kv.get<number>('registrationId');
  }

  async setLocalIdentity(pair: KeyPairType, registrationId: number) {
    await this.kv.set('identityKey', toStored(pair));
    await this.kv.set('registrationId', registrationId);
  }

  // Trust on first use. A changed key is rejected here; the messenger decides
  // when to accept it (and surfaces a "safety number changed" warning).
  async isTrustedIdentity(identifier: string, identityKey: ArrayBuffer, _direction: Direction) {
    const known = await this.loadIdentity(userOf(identifier));
    return !known || equalBuf(known, identityKey);
  }

  async loadIdentity(userId: string) {
    const k = await this.kv.get<string>(`identity:${userId}`);
    return k ? b64ToBuf(k) : undefined;
  }

  async saveIdentity(encodedAddress: string, publicKey: ArrayBuffer) {
    const userId = userOf(encodedAddress);
    const known = await this.loadIdentity(userId);
    await this.kv.set(`identity:${userId}`, bufToB64(publicKey));
    return !!known && !equalBuf(known, publicKey);
  }

  async forgetIdentity(userId: string) {
    await this.kv.del(`identity:${userId}`);
  }

  async loadPreKey(keyId: string | number) {
    return fromStored(await this.kv.get<StoredPair>(`prekey:${keyId}`));
  }
  async storePreKey(keyId: string | number, keyPair: KeyPairType) {
    await this.kv.set(`prekey:${keyId}`, toStored(keyPair));
  }
  async removePreKey(keyId: string | number) {
    await this.kv.del(`prekey:${keyId}`);
  }

  async loadSignedPreKey(keyId: string | number) {
    return fromStored(await this.kv.get<StoredPair>(`signedprekey:${keyId}`));
  }
  async storeSignedPreKey(keyId: string | number, keyPair: KeyPairType) {
    await this.kv.set(`signedprekey:${keyId}`, toStored(keyPair));
  }
  async removeSignedPreKey(keyId: string | number) {
    await this.kv.del(`signedprekey:${keyId}`);
  }

  async loadSession(encodedAddress: string) {
    return this.kv.get<string>(`session:${encodedAddress}`);
  }
  async storeSession(encodedAddress: string, record: string) {
    await this.kv.set(`session:${encodedAddress}`, record);
  }
  async removeSession(encodedAddress: string) {
    await this.kv.del(`session:${encodedAddress}`);
  }
}
