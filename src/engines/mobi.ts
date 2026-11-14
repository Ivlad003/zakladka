// Kindle books without DRM — MOBI, PRC, AZW and AZW3 — turned into an EPUB on the device when
// they are added, the same way FB2 is.
//
// The file is a Palm database: a list of records. Record 0 describes the book (how the text is
// compressed, its encoding, where the pictures start, title and author); the next records hold
// the text, cut into 4 KB pieces and usually compressed with PalmDOC's small LZ77 scheme; the
// pictures follow, one per record.
//
// Two generations of markup live in such files:
//  • MOBI 6 — one long HTML page. Chapters are separated by <mbp:pagebreak>, links point at byte
//    offsets (filepos=12345), pictures are numbered (recindex=3).
//  • KF8 (AZW3) — XHTML cut into "skeletons" and "fragments". Putting it back together exactly
//    needs the index tables; here the pieces are read in the order they are stored, which keeps
//    all the text and pictures in reading order but drops links between chapters.
// A file that carries both uses the MOBI 6 half. Books sold with DRM cannot be read at all.
import { buildEpub, type EpubToc } from './epub-build';

const text4 = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** Whether the file is a Kindle/Mobipocket book (by its signature, whatever it is called). */
export function isMobi(head: Uint8Array): boolean {
  return head.length >= 68 && text4(head, 60) === 'BOOK' && text4(head, 64) === 'MOBI';
}

/** PalmDOC compression: literals, "space + letter" pairs and short copies from the last 2 KB. */
function unpackPalmDoc(data: Uint8Array): Uint8Array {
  let out = new Uint8Array(Math.max(8192, data.length * 3));
  let n = 0;
  const room = (extra: number) => {
    if (n + extra <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, n + extra));
    bigger.set(out.subarray(0, n));
    out = bigger;
  };
  for (let p = 0; p < data.length; ) {
    const c = data[p++];
    if (c >= 1 && c <= 8) {
      room(c);
      for (let i = 0; i < c && p < data.length; i++) out[n++] = data[p++];
    } else if (c < 0x80) {
      room(1);
      out[n++] = c;
    } else if (c >= 0xc0) {
      room(2);
      out[n++] = 0x20;
      out[n++] = c ^ 0x80;
    } else if (p < data.length) {
      const pair = (c << 8) | data[p++];
      const distance = (pair >> 3) & 0x7ff;
      const length = (pair & 7) + 3;
      if (distance === 0 || distance > n) continue; // damaged data: skip rather than read outside
      room(length);
      // Byte by byte on purpose: the copy may overlap what it is writing.
      for (let i = 0; i < length; i++, n++) out[n] = out[n - distance];
    }
  }
  return out.subarray(0, n);
}

/** How many bytes at the end of a text record are not text (index data, the tail of a split character). */
function trailingSize(record: Uint8Array, flags: number): number {
  let size = record.length;
  let total = 0;
  for (let bit = flags >> 1; bit; bit >>= 1) {
    if (!(bit & 1)) continue;
    // A number written backwards, seven bits per byte, the top bit marking its first byte.
    let value = 0;
    let shift = 0;
    let at = size - total;
    while (at > 0) {
      const v = record[--at];
      value |= (v & 0x7f) << shift;
      shift += 7;
      if (v & 0x80 || shift >= 28) break;
    }
    total += value;
  }
  if (flags & 1 && size - total > 0) total += (record[size - total - 1] & 3) + 1;
  return Math.min(total, size);
}

interface Picture {
  file: string;
  type: string;
  data: Uint8Array;
}

function pictureType(data: Uint8Array): { type: string; ext: string } | null {
  if (data[0] === 0xff && data[1] === 0xd8) return { type: 'image/jpeg', ext: 'jpg' };
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return { type: 'image/png', ext: 'png' };
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return { type: 'image/gif', ext: 'gif' };
  if (data[0] === 0x42 && data[1] === 0x4d) return { type: 'image/bmp', ext: 'bmp' };
  return null;
}

const STYLE = `body { line-height: 1.5; }
h1, h2, h3 { line-height: 1.25; margin: 1.2em 0 0.7em; }
p { margin: 0 0 0.4em; }
img { max-width: 100%; height: auto; }
blockquote { margin: 1em 0 1em 2em; }
`;

const TEXT_TAGS = new Set(['script', 'style', 'link', 'meta', 'title', 'base', 'object', 'embed', 'iframe', 'form', 'input', 'button', 'select', 'textarea']);

export interface MobiBook {
  epub: Blob;
  title: string;
  author: string;
}

export async function mobiToEpub(file: Uint8Array): Promise<MobiBook> {
  if (!isMobi(file)) throw new Error('це не файл MOBI');
  const count = u16(file, 76);
  const starts: number[] = [];
  for (let i = 0; i < count; i++) starts.push(u32(file, 78 + i * 8));
  const record = (i: number) => (i >= 0 && i < count ? file.subarray(starts[i], i + 1 < count ? starts[i + 1] : file.length) : new Uint8Array(0));

  // ---- What the book is ----
  const head = record(0);
  if (head.length < 132 || text4(head, 16) !== 'MOBI') throw new Error('у файлі немає заголовка MOBI');
  const compression = u16(head, 0);
  const textLength = u32(head, 4);
  const textRecords = u16(head, 8);
  if (u16(head, 12) !== 0) throw new Error('книга захищена DRM — такі файли прочитати не можна');
  if (compression !== 1 && compression !== 2) throw new Error('цей спосіб стиснення MOBI (HUFF/CDIC) не підтримується');
  const headerLength = u32(head, 20);
  const utf8 = u32(head, 28) === 65001;
  const version = u32(head, 36);
  const firstPicture = u32(head, 108);
  const extraFlags = headerLength >= 0xe4 && version >= 5 && head.length >= 0xf4 ? u16(head, 0xf2) : 0;
  const decode = (bytes: Uint8Array) => new TextDecoder(utf8 ? 'utf-8' : 'windows-1252').decode(bytes);

  let title = decode(head.subarray(u32(head, 84), u32(head, 84) + u32(head, 88))).trim();
  const authors: string[] = [];
  let lang = 'und';
  let coverOffset = -1;
  if (u32(head, 128) & 0x40 && text4(head, 16 + headerLength) === 'EXTH') {
    const exth = 16 + headerLength;
    let at = exth + 12;
    for (let i = 0, items = u32(head, exth + 8); i < items && at + 8 <= head.length; i++) {
      const type = u32(head, at);
      const size = u32(head, at + 4);
      if (size < 8) break;
      const data = head.subarray(at + 8, at + size);
      if (type === 100) authors.push(decode(data).trim());
      else if (type === 503 && data.length) title = decode(data).trim();
      else if (type === 524) lang = decode(data).trim() || lang;
      else if (type === 201 && data.length >= 4) coverOffset = u32(data, 0);
      at += size;
    }
  }
  title ||= 'Без назви';

  // ---- The text ----
  const pieces: Uint8Array[] = [];
  let total = 0;
  for (let i = 1; i <= textRecords && i < count; i++) {
    const raw = record(i);
    const body = raw.subarray(0, raw.length - trailingSize(raw, extraFlags));
    const piece = compression === 2 ? unpackPalmDoc(body) : body;
    pieces.push(piece);
    total += piece.length;
  }
  let raw: Uint8Array = new Uint8Array(total);
  let filled = 0;
  for (const piece of pieces) {
    raw.set(piece, filled);
    filled += piece.length;
  }
  if (textLength && textLength < raw.length) raw = raw.subarray(0, textLength);
  if (!raw.length) throw new Error('у файлі MOBI немає тексту');

  const kf8 = version >= 8;
  if (kf8) {
    // The text is followed by stylesheets and other "flows"; a small table says where the first one ends.
    const fdst = record(u32(head, 192));
    if (fdst.length >= 20 && text4(fdst, 0) === 'FDST') {
      const from = u32(fdst, 12);
      const to = u32(fdst, 16);
      if (to > from && to <= raw.length) raw = raw.subarray(from, to);
    }
  } else {
    raw = withAnchors(raw);
  }
  let source = decode(raw);

  // ---- Pictures ----
  const pictures = new Map<number, Picture>();
  const picture = (number: number): Picture | null => {
    if (!Number.isFinite(number) || number < 1) return null;
    const known = pictures.get(number);
    if (known) return known;
    const data = record(firstPicture + number - 1);
    const kind = pictureType(data);
    if (!kind) return null;
    const made = { file: `images/img${String(number).padStart(5, '0')}.${kind.ext}`, type: kind.type, data };
    pictures.set(number, made);
    return made;
  };

  // ---- Markup: from Kindle's dialect to something a browser parses the way it was meant ----
  // Where the book's own table of contents is (MOBI 6 keeps a pointer in its guide).
  const tocAt = /<reference\b[^>]*type=["']?toc["']?[^>]*filepos=["']?0*(\d+)|<reference\b[^>]*filepos=["']?0*(\d+)[^>]*type=["']?toc/i.exec(source);
  const tocAnchor = tocAt ? `filepos${tocAt[1] ?? tocAt[2]}` : null;
  const BREAK = '\u0001';
  source = source
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, kf8 ? BREAK : '')
    .replace(/<mbp:pagebreak\b[^>]*>/gi, BREAK)
    .replace(/<\/?mbp:[^>]*>/gi, '')
    .replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/gi, '')
    .replace(/\bfilepos=["']?0*(\d+)["']?/gi, 'href="#filepos$1"')
    .replace(/\brecindex=["']?0*(\d+)["']?/gi, 'data-picture="$1"')
    .replace(/\bsrc=["']kindle:embed:([0-9A-V]+)[^"']*["']/gi, (_, code: string) => `data-picture="${parseInt(code, 32)}"`)
    .replace(/\bhref=["']kindle:[^"']*["']/gi, '');

  // ---- Chapters ----
  const parser = new DOMParser();
  const chunks = source.split(BREAK).flatMap(splitLong);
  const chapters: { name: string; doc: Document; title: string }[] = [];
  const anchors = new Map<string, string>();
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const doc = parser.parseFromString(`<!DOCTYPE html><html><body>${chunk}</body></html>`, 'text/html');
    tidy(doc, picture);
    if (!doc.body.textContent?.trim() && !doc.body.querySelector('img')) continue;
    const name = `ch${String(chapters.length + 1).padStart(4, '0')}.xhtml`;
    for (const el of Array.from(doc.body.querySelectorAll('[id]'))) anchors.set(el.id, name);
    const heading = doc.body.querySelector('h1, h2, h3');
    chapters.push({ name, doc, title: (heading?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) });
  }
  if (!chapters.length) throw new Error('у файлі MOBI немає тексту');

  // Links: to the file their target is in, or plain text when the target is gone.
  for (const chapter of chapters) {
    for (const link of Array.from(chapter.doc.body.querySelectorAll('a[href^="#"]'))) {
      const id = link.getAttribute('href')!.slice(1);
      const target = anchors.get(id);
      if (!target) link.removeAttribute('href');
      else if (target !== chapter.name) link.setAttribute('href', `${target}#${id}`);
    }
  }

  // ---- Table of contents: the book's own, else its headings, else the chapters by number ----
  let toc: EpubToc[] = [];
  const tocChapter = tocAnchor ? chapters.find((c) => c.name === anchors.get(tocAnchor)) : undefined;
  if (tocChapter) {
    toc = Array.from(tocChapter.doc.body.querySelectorAll('a[href]'))
      .map((a) => ({ title: (a.textContent ?? '').replace(/\s+/g, ' ').trim(), href: a.getAttribute('href')!, depth: 1 }))
      .filter((entry) => entry.title && /filepos/.test(entry.href))
      .map((entry) => ({ ...entry, href: entry.href.startsWith('#') ? `${tocChapter.name}${entry.href}` : entry.href }));
  }
  if (toc.length < 2) {
    const titled = chapters.filter((c) => c.title);
    toc = (titled.length >= 2 ? titled : chapters).map((c, i) => ({ title: c.title || (i === 0 ? title : `Розділ ${i + 1}`), href: c.name, depth: 1 }));
  }

  const cover = coverOffset >= 0 ? picture(coverOffset + 1) : null;
  const serializer = new XMLSerializer();
  const epub = await buildEpub({
    id: `urn:mobi:${file.length}-${chapters.length}`,
    title,
    authors,
    lang,
    css: STYLE,
    files: chapters.map((c, i) => ({
      name: c.name,
      title: c.title || (i === 0 ? title : `Розділ ${i + 1}`),
      body: Array.from(c.doc.body.childNodes)
        .map((node) => (node.nodeType === 1 ? serializer.serializeToString(node) : node.nodeType === 3 && node.nodeValue?.trim() ? `<p>${escapeText(node.nodeValue)}</p>` : ''))
        .join('\n'),
    })),
    images: [...pictures.values()],
    cover: cover?.file,
    toc,
  });
  return { epub, title, author: authors.join(', ') };
}

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * MOBI 6 links say "byte 12345 of the text". Before the text is decoded and cut into chapters,
 * an anchor is put at every byte that something points to.
 */
function withAnchors(raw: Uint8Array): Uint8Array {
  // Latin-1 keeps one character per byte, so offsets found in it are byte offsets.
  const ascii = new TextDecoder('latin1').decode(raw);
  const wanted = new Set<number>();
  for (const m of ascii.matchAll(/filepos=["']?(\d+)/gi)) {
    const at = Number(m[1]);
    if (at > 0 && at < raw.length) wanted.add(at);
  }
  if (!wanted.size) return raw;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let from = 0;
  let size = 0;
  for (const target of [...wanted].sort((a, b) => a - b)) {
    // An offset that lands inside a tag moves to the start of that tag.
    let at = target;
    const open = ascii.lastIndexOf('<', at - 1);
    if (open >= 0 && ascii.lastIndexOf('>', at - 1) < open) at = open;
    if (at < from) at = from;
    const anchor = encoder.encode(`<a id="filepos${target}"></a>`);
    parts.push(raw.subarray(from, at), anchor);
    size += at - from + anchor.length;
    from = at;
  }
  parts.push(raw.subarray(from));
  size += raw.length - from;
  const out = new Uint8Array(size);
  let n = 0;
  for (const part of parts) {
    out.set(part, n);
    n += part.length;
  }
  return out;
}

/** A book with no page breaks is still cut into pieces a phone can lay out: at headings, then at paragraphs. */
function splitLong(chunk: string): string[] {
  const LIMIT = 200_000;
  if (chunk.length <= LIMIT) return [chunk];
  const out: string[] = [];
  let rest = chunk;
  while (rest.length > LIMIT) {
    const window = rest.slice(LIMIT / 2, LIMIT);
    const heading = window.search(/<h[1-3][\s>]/i);
    const paragraph = window.lastIndexOf('<p');
    const cut = LIMIT / 2 + (heading >= 0 ? heading : paragraph >= 0 ? paragraph : window.length);
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

/** Makes a parsed chunk safe and well-formed enough to be written out as XHTML. */
function tidy(doc: Document, picture: (number: number) => Picture | null): void {
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    const name = el.localName;
    if (TEXT_TAGS.has(name)) {
      el.remove();
      continue;
    }
    // Names from other vocabularies (o:p, st1:place…) cannot be written into XHTML as they are.
    if (!/^[a-z][a-z0-9]*$/.test(name)) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const key = attr.name.toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(key) || key.startsWith('on') || (key === 'href' && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name);
    }
    if (name === 'img') {
      const found = picture(Number(el.getAttribute('data-picture')));
      el.removeAttribute('data-picture');
      el.removeAttribute('srcset');
      if (!found) {
        el.remove();
        continue;
      }
      el.setAttribute('src', found.file);
      if (!el.hasAttribute('alt')) el.setAttribute('alt', '');
    }
    // Mobipocket's own way of saying "indent" and "space above".
    if (name === 'p' || name === 'div' || name === 'blockquote') {
      const indent = el.getAttribute('width');
      const above = el.getAttribute('height');
      const css = [indent && /^-?[\d.]+(em|px|pt|%)?$/.test(indent) ? `text-indent: ${indent}` : '', above && /^[\d.]+(em|px|pt)?$/.test(above) ? `margin-top: ${above}` : ''].filter(Boolean).join('; ');
      if (css) el.setAttribute('style', [el.getAttribute('style'), css].filter(Boolean).join('; '));
      el.removeAttribute('width');
      el.removeAttribute('height');
    }
  }
}
