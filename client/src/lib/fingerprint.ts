// Signal's numeric safety number (fingerprint version 0), computed with native
// WebCrypto. The library's FingerprintGenerator always uses a pure-JS SHA-512
// polyfill, which takes far too long in browsers for 5200 iterations × 2.
// Output is identical to FingerprintGenerator(iterations).createFor(...).

const ITERATIONS = 5200;

function concat(...parts: ArrayBuffer[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), off);
    off += p.byteLength;
  }
  return out.buffer;
}

function ascii(s: string) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out.buffer;
}

function chunk(h: Uint8Array, o: number) {
  const n = (h[o] * 2 ** 32 + h[o + 1] * 2 ** 24 + h[o + 2] * 2 ** 16 + h[o + 3] * 2 ** 8 + h[o + 4]) % 100000;
  return n.toString().padStart(5, '0');
}

async function displayStringFor(identifier: string, key: ArrayBuffer, iterations: number) {
  let hash = concat(new Uint16Array([0]).buffer, key, ascii(identifier));
  for (let i = 0; i < iterations; i++) hash = await crypto.subtle.digest('SHA-512', concat(hash, key));
  const h = new Uint8Array(hash);
  return [0, 5, 10, 15, 20, 25].map((o) => chunk(h, o)).join('');
}

export async function safetyNumber(
  localId: string,
  localKey: ArrayBuffer,
  remoteId: string,
  remoteKey: ArrayBuffer,
  iterations = ITERATIONS,
) {
  const a = await displayStringFor(localId, localKey, iterations);
  const b = await displayStringFor(remoteId, remoteKey, iterations);
  return [a, b].sort().join('');
}
