import { DatabaseSync } from 'node:sqlite';

// The server only ever stores public key material and opaque ciphertext.
// Message plaintext, read receipts and group content never reach it.
export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      pw_salt TEXT NOT NULL,
      created INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS identities (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      registration_id INTEGER NOT NULL,
      identity_key TEXT NOT NULL,
      signed_prekey_id INTEGER NOT NULL,
      signed_prekey TEXT NOT NULL,
      signed_prekey_sig TEXT NOT NULL,
      updated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prekeys (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_id INTEGER NOT NULL,
      public_key TEXT NOT NULL,
      PRIMARY KEY (user_id, key_id)
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      invite_code TEXT NOT NULL UNIQUE,
      created INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined INTEGER NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS envelopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL,
      type INTEGER NOT NULL,
      body TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS envelopes_recipient ON envelopes(recipient_id, id);
  `);
  return db;
}

export type Db = ReturnType<typeof openDb>;
