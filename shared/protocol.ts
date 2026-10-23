// Wire types shared by server and client. Everything here is visible to the
// server; anything private travels inside `Envelope.body` as Signal ciphertext.

export interface PublicUser {
  id: string;
  name: string;
}

export interface Me extends PublicUser {
  email: string;
}

export interface AuthResponse {
  token: string;
  user: Me;
}

export interface PreKeyUpload {
  keyId: number;
  publicKey: string; // base64
}

export interface SignedPreKeyUpload extends PreKeyUpload {
  signature: string; // base64
}

export interface KeyUpload {
  registrationId: number;
  identityKey: string; // base64
  signedPreKey: SignedPreKeyUpload;
  preKeys: PreKeyUpload[];
}

export interface PreKeyBundle {
  userId: string;
  registrationId: number;
  identityKey: string;
  signedPreKey: SignedPreKeyUpload;
  preKey?: PreKeyUpload;
}

export interface Group {
  id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
  members: PublicUser[];
}

// Signal message types: 1 = WhisperMessage, 3 = PreKeyWhisperMessage.
export interface Envelope {
  id: number;
  from: string;
  type: number;
  body: string; // base64 ciphertext
  at: number;
}

export interface OutgoingEnvelope {
  to: string;
  type: number;
  body: string;
}

export type ClientFrame =
  | { t: 'send'; ref: string; envelopes: OutgoingEnvelope[] }
  | { t: 'ack'; ids: number[] };

export type ServerFrame =
  | { t: 'envelope'; envelope: Envelope }
  | { t: 'sent'; ref: string; rejected: string[] }
  | { t: 'group'; groupId: string }
  | { t: 'identity'; userId: string }
  | { t: 'prekeys-low' };

export const PREKEY_BATCH = 100;
export const PREKEY_LOW_WATER = 20;
