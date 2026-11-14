// Browsers expose `crypto.subtle` only on HTTPS and localhost. Opened by a plain LAN address
// (http://192.168.x.x — the simplest way to reach the reader from a phone at home) the page has
// none, and request signing for the sync storage would fail. This fills in the three operations
// the signer needs, in plain JavaScript. It does nothing where the real implementation exists.
import { sha256 } from './hash';

type Bytes = ArrayBuffer | ArrayBufferView;
interface ShimKey {
  raw: Uint8Array;
}

const toBytes = (data: Bytes) => (data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha256(key) : key;
  const inner = new Uint8Array(64 + data.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    const b = k[i] ?? 0;
    inner[i] = b ^ 0x36;
    outer[i] = b ^ 0x5c;
  }
  inner.set(data, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

/** The subset of SubtleCrypto used for AWS Signature V4: HMAC-SHA-256 keys, signing, SHA-256 digests. */
export const subtleShim = {
  async importKey(_format: string, key: Bytes): Promise<ShimKey> {
    return { raw: toBytes(key).slice() };
  },
  async sign(_algorithm: unknown, key: ShimKey, data: Bytes): Promise<ArrayBuffer> {
    return hmacSha256(key.raw, toBytes(data)).buffer as ArrayBuffer;
  },
  async digest(_algorithm: unknown, data: Bytes): Promise<ArrayBuffer> {
    return sha256(toBytes(data)).buffer as ArrayBuffer;
  },
};

export function installSubtleShim(): void {
  if (typeof crypto === 'undefined' || crypto.subtle) return;
  Object.defineProperty(crypto, 'subtle', { value: subtleShim, configurable: true });
}
