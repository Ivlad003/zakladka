// Reads the table of contents of a DjVu file (the NAVM chunk).
//
// djvu-rs does not expose bookmarks to JavaScript, so this small reader is our own, written from the
// public DjVu v3 specification: the IFF container (section 8), the DIRM and NAVM chunks (8.3.2, 8.3.3),
// the Z'-coder (appendix 3) and the BZZ compressor (appendix 4). It only decodes those two small chunks.
import type { TocItem } from '../types';
import { ZP_DN, ZP_M, ZP_P, ZP_UP } from './zp-tables';

/** Z'-coder: an adaptive binary arithmetic decoder (specification appendix 3, figures 1 and 2). */
class ZpDecoder {
  private a = 0;
  private c: number;
  private pos: number;
  private bits = 0;
  private bitCount = 0;

  constructor(
    private data: Uint8Array,
    start: number,
    private end: number,
  ) {
    this.pos = start;
    this.c = (this.nextByte() << 8) | this.nextByte();
  }

  /** Past the end of the chunk the decoder reads 1 bits. */
  private nextByte(): number {
    return this.pos < this.end ? this.data[this.pos++] : 0xff;
  }

  private renormalize(): void {
    while (this.a >= 0x8000) {
      if (this.bitCount === 0) {
        this.bits = this.nextByte();
        this.bitCount = 8;
      }
      this.bitCount--;
      this.a = this.a + this.a - 0x10000;
      this.c = this.c + this.c - 0x10000 + ((this.bits >> this.bitCount) & 1);
    }
  }

  /** Decodes one bit with the adaptive context `contexts[i]`. */
  decode(contexts: Uint8Array, i: number): number {
    const k = contexts[i];
    let z = this.a + ZP_P[k];
    // The code value lies in [a, 0x10000); the upper part [z, …) is the more probable symbol (MPS).
    // While the interval needs no renormalisation an MPS leaves the probability state alone. Figure 1
    // of the specification omits this condition, but encoders rely on it (as does the MIT-licensed
    // djvu-rs decoder, which this was checked against).
    if (z < 0x8000 && z <= this.c) {
      this.a = z;
      return k & 1;
    }
    const d = 0x6000 + ((z + this.a) >> 2);
    if (z > d) z = d;
    let bit: number;
    if (this.c >= z) {
      bit = k & 1;
      if (this.a >= ZP_M[k]) contexts[i] = ZP_UP[k];
      this.a = z;
    } else {
      bit = 1 - (k & 1);
      this.a += 0x10000 - z;
      this.c += 0x10000 - z;
      contexts[i] = ZP_DN[k];
    }
    this.renormalize();
    return bit;
  }

  /**
   * Decodes one bit without a context ("pass-through" mode). BZZ splits the interval at a/2; the
   * 3a/8 split shown in figure 2 of the specification is the variant used by the IW44 image codec.
   */
  passthrough(): number {
    const z = 0x8000 + (this.a >> 1);
    let bit: number;
    if (this.c >= z) {
      bit = 0;
      this.a = z;
    } else {
      bit = 1;
      this.a += 0x10000 - z;
      this.c += 0x10000 - z;
    }
    this.renormalize();
    return bit;
  }
}

const MAX_BLOCK = 8 * 1024 * 1024;

/** BZZ: Burrows–Wheeler blocks whose move-to-front indices are Z'-coded (specification appendix 4). */
function bzzDecode(data: Uint8Array, start: number, end: number): Uint8Array {
  const zp = new ZpDecoder(data, start, end);
  // 262 contexts, zeroed once per stream and kept across blocks.
  const contexts = new Uint8Array(262);
  const raw = (bitCount: number) => {
    let n = 1;
    const limit = 1 << bitCount;
    while (n < limit) n = n * 2 + zp.passthrough();
    return n - limit;
  };
  const binary = (offset: number, bitCount: number) => {
    let n = 1;
    const limit = 1 << bitCount;
    while (n < limit) n = n * 2 + zp.decode(contexts, offset + n - 1);
    return n - limit;
  };

  const out: Uint8Array[] = [];
  for (;;) {
    const size = raw(24);
    if (size === 0) break;
    if (size > MAX_BLOCK) throw new Error('BZZ: block too large');

    let fshift = 0;
    if (zp.passthrough()) fshift = zp.passthrough() ? 2 : 1;

    const mtf = new Uint8Array(256);
    for (let i = 0; i < 256; i++) mtf[i] = i;
    const freq = [0, 0, 0, 0];
    let fadd = 4;
    let mtfno = 3;
    let marker = -1;
    const block = new Uint8Array(size);

    // Phase 1: arithmetic decoding of the move-to-front positions.
    for (let i = 0; i < size; i++) {
      const ctxid = Math.min(mtfno, 2);
      if (zp.decode(contexts, ctxid)) mtfno = 0;
      else if (zp.decode(contexts, ctxid + 3)) mtfno = 1;
      else if (zp.decode(contexts, 6)) mtfno = 2 + binary(7, 1);
      else if (zp.decode(contexts, 8)) mtfno = 4 + binary(9, 2);
      else if (zp.decode(contexts, 12)) mtfno = 8 + binary(13, 3);
      else if (zp.decode(contexts, 20)) mtfno = 16 + binary(21, 4);
      else if (zp.decode(contexts, 36)) mtfno = 32 + binary(37, 5);
      else if (zp.decode(contexts, 68)) mtfno = 64 + binary(69, 6);
      else if (zp.decode(contexts, 132)) mtfno = 128 + binary(133, 7);
      else {
        // The single end-of-block symbol: remember where it sits in the transformed block.
        mtfno = 256;
        block[i] = 0;
        marker = i;
        continue;
      }
      const symbol = mtf[mtfno];
      block[i] = symbol;

      // Keep the most frequent symbols at the front of the list.
      fadd += fadd >> fshift;
      if (fadd > 0x10000000) {
        fadd >>= 24;
        for (let j = 0; j < 4; j++) freq[j] >>= 24;
      }
      const fc = mtfno < 4 ? fadd + freq[mtfno] : fadd;
      let k = mtfno;
      for (; k > 3; k--) mtf[k] = mtf[k - 1];
      for (; k > 0 && fc >= freq[k - 1]; k--) {
        mtf[k] = mtf[k - 1];
        freq[k] = freq[k - 1];
      }
      mtf[k] = symbol;
      freq[k] = fc;
    }
    if (marker < 1 || marker >= size) throw new Error('BZZ: corrupt block');

    // Phase 2: inverse Burrows–Wheeler transform.
    const count = new Int32Array(256);
    const rank = new Int32Array(size);
    for (let i = 0; i < size; i++) {
      if (i === marker) continue;
      rank[i] = count[block[i]]++;
    }
    let position = 1;
    for (let i = 0; i < 256; i++) {
      const n = count[i];
      count[i] = position;
      position += n;
    }
    if (position !== size) throw new Error('BZZ: corrupt block');
    const decoded = new Uint8Array(size - 1);
    let k = 0;
    for (let last = size - 1; last > 0; ) {
      last--;
      const symbol = block[k];
      decoded[last] = symbol;
      k = count[symbol] + rank[k];
    }
    if (k !== marker) throw new Error('BZZ: corrupt block');
    out.push(decoded);
  }

  if (out.length === 1) return out[0];
  const joined = new Uint8Array(out.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of out) {
    joined.set(b, offset);
    offset += b.length;
  }
  return joined;
}

const ascii = (data: Uint8Array, at: number, length: number) => String.fromCharCode(...data.subarray(at, at + length));
const u32 = (d: Uint8Array, at: number) => ((d[at] << 24) | (d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]) >>> 0;
const u24 = (d: Uint8Array, at: number) => (d[at] << 16) | (d[at + 1] << 8) | d[at + 2];
const u16 = (d: Uint8Array, at: number) => (d[at] << 8) | d[at + 1];

/** Page index for each component-file id of a multi-page document (DIRM chunk). */
function readDirectory(data: Uint8Array, start: number, end: number): Map<string, number> {
  let pos = start;
  const bundled = (data[pos++] & 0x80) !== 0;
  const fileCount = u16(data, pos);
  pos += 2;
  if (bundled) pos += 4 * fileCount; // offsets of the component files; not needed here

  const dir = bzzDecode(data, pos, end);
  const flagsAt = 3 * fileCount; // after the 24-bit sizes
  let at = 4 * fileCount; // after the flag bytes: zero-terminated strings
  const utf8 = new TextDecoder();
  const readString = () => {
    let stop = at;
    while (stop < dir.length && dir[stop] !== 0) stop++;
    const value = utf8.decode(dir.subarray(at, stop));
    at = stop + 1;
    return value;
  };

  const pages = new Map<string, number>();
  let pageIndex = 0;
  for (let i = 0; i < fileCount; i++) {
    const flags = dir[flagsAt + i];
    const names = [readString()];
    if (flags & 0x80) names.push(readString());
    if (flags & 0x40) names.push(readString());
    if ((flags & 0x3f) !== 1) continue; // 1 = a page; 0 = shared data, 2 = thumbnails
    for (const name of names) if (!pages.has(name)) pages.set(name, pageIndex);
    pageIndex++;
  }
  pages.set('\0count', pageIndex);
  return pages;
}

/** Returns the document outline, or an empty list when the file has none. Throws on malformed data. */
export function readDjvuOutline(data: Uint8Array): TocItem[] {
  if (data.length < 16 || ascii(data, 0, 8) !== 'AT&TFORM' || ascii(data, 12, 4) !== 'DJVM') return [];
  const formEnd = Math.min(data.length, 12 + u32(data, 8));

  let directory: Map<string, number> | null = null;
  let navm: [number, number] | null = null;
  // The directory comes first and the outline, when present, right after it.
  for (let pos = 16, seen = 0; pos + 8 <= formEnd && seen < 2; seen++) {
    const id = ascii(data, pos, 4);
    const size = u32(data, pos + 4);
    const start = pos + 8;
    const end = Math.min(formEnd, start + size);
    if (id === 'DIRM') directory = readDirectory(data, start, end);
    else if (id === 'NAVM') navm = [start, end];
    else break;
    pos = start + size + (size & 1);
  }
  if (!navm) return [];

  const bytes = bzzDecode(data, navm[0], navm[1]);
  const utf8 = new TextDecoder();
  const pageCount = directory?.get('\0count') ?? Number.MAX_SAFE_INTEGER;
  const resolve = (url: string): number | undefined => {
    if (!url.startsWith('#')) return undefined;
    const ref = url.slice(1);
    const byName = directory?.get(ref);
    if (byName !== undefined) return byName;
    const number = /^\d+$/.test(ref) ? Number(ref) : NaN;
    return number >= 1 && number <= pageCount ? number - 1 : undefined;
  };

  let remaining = u16(bytes, 0);
  let pos = 2;
  const readItem = (): TocItem | null => {
    remaining--;
    const childCount = bytes[pos++];
    const titleLength = u24(bytes, pos);
    pos += 3;
    const title = utf8.decode(bytes.subarray(pos, pos + titleLength)).replace(/\0+$/, '').trim();
    pos += titleLength;
    const urlLength = u24(bytes, pos);
    pos += 3;
    const url = utf8.decode(bytes.subarray(pos, pos + urlLength)).replace(/\0+$/, '');
    pos += urlLength;
    const children: TocItem[] = [];
    for (let i = 0; i < childCount && remaining > 0 && pos < bytes.length; i++) {
      const child = readItem();
      if (child) children.push(child);
    }
    // Some producers add a bookmark per page whose title is just the page file's id ("p0012.djvu").
    // They carry no information and would otherwise show up as chapter names.
    if (!children.length && (title === url.slice(1) || directory?.has(title) || /^[\w.-]+\.djvu?$/i.test(title))) return null;
    return { title: title || '—', unit: resolve(url), children };
  };

  const items: TocItem[] = [];
  while (remaining > 0 && pos < bytes.length) {
    const item = readItem();
    if (item) items.push(item);
  }
  return items;
}
