// Minimal async key-value store. The app uses IndexedDB; tests use memory.
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

const STORE = 'kv';
const dbName = (namespace: string) => `secure-chat:${namespace}`;
const open = new Map<string, Promise<IDBDatabase>>();

function promisify<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function connect(name: string) {
  let db = open.get(name);
  if (!db) {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    db = promisify(req).then((conn) => {
      // Let a pending wipe delete the database instead of being blocked by us.
      conn.onversionchange = () => {
        conn.close();
        open.delete(name);
      };
      return conn;
    });
    open.set(name, db);
  }
  return db;
}

async function run<T>(name: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
  const db = await connect(name);
  return promisify(fn(db.transaction(STORE, mode).objectStore(STORE)));
}

export function idbKV(namespace: string): KV {
  const name = dbName(namespace);
  return {
    get: (k) => run(name, 'readonly', (s) => s.get(k)),
    set: async (k, v) => void (await run(name, 'readwrite', (s) => s.put(v, k))),
    del: async (k) => void (await run(name, 'readwrite', (s) => s.delete(k))),
  };
}

// Erases everything this phone stored for an account: Signal keys, sessions,
// message history and receipts. Resolves once the database is gone.
export async function wipeIdb(namespace: string) {
  const name = dbName(namespace);
  const db = await open.get(name)?.catch(() => undefined);
  db?.close();
  open.delete(name);
  await promisify(indexedDB.deleteDatabase(name));
}

export function memoryKV(): KV {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => structuredClone(m.get(k)) as any,
    set: async (k, v) => void m.set(k, structuredClone(v)),
    del: async (k) => void m.delete(k),
  };
}
