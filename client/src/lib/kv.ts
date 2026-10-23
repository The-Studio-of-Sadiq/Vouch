import { createStore, get, set, del } from 'idb-keyval';

// Minimal async key-value store. The browser uses IndexedDB; tests use memory.
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

export function idbKV(namespace: string): KV {
  const store = createStore(`secure-chat:${namespace}`, 'kv');
  return {
    get: (k) => get(k, store),
    set: (k, v) => set(k, v, store),
    del: (k) => del(k, store),
  };
}

export function memoryKV(): KV {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => structuredClone(m.get(k)) as any,
    set: async (k, v) => void m.set(k, structuredClone(v)),
    del: async (k) => void m.delete(k),
  };
}
