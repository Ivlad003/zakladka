// JW Library publications (.jwpub), turned into an EPUB on the device when they are added, the
// same way FB2 and MOBI are.
//
// The file is a ZIP with `manifest.json` and a second ZIP, `contents`, which holds an SQLite
// database and the pictures. Every document of the publication is a row of the Document table.
// Its text is HTML, deflated and then encrypted with AES-128-CBC; the key is worked out from the
// publication's own language number, symbol and year. The table of contents is a tree in
// PublicationViewItem, footnotes are rows of Footnote, and a Bible keeps its chapters in
// BibleChapter. Links use their own scheme: jwpub://p/ (a document), jwpub://b/ (a scripture),
// jwpub-media:// (a picture).
//
// What does not survive: scripture links in an ordinary publication (the verses are not in the
// file — JW Library takes them from an installed Bible), cross-references, video, and the
// interactive parts of home-made publications.
import JSZip from 'jszip';
import { sha256 } from '../lib/hash';
import { guessLang } from '../lib/read-aloud';
import { buildEpub, type EpubToc } from './epub-build';
import { SqliteFile, type SqlValue } from './sqlite';

// ---- AES-128-CBC, decryption only ----
// In plain JavaScript: the browser's own implementation exists only on HTTPS and localhost, and
// the reader is also opened by a plain LAN address.
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const xtime = (x: number) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
const times = (a: number, b: number) => {
  let out = 0;
  for (; b; b >>= 1, a = xtime(a)) if (b & 1) out ^= a;
  return out;
};
const M9 = new Uint8Array(256);
const M11 = new Uint8Array(256);
const M13 = new Uint8Array(256);
const M14 = new Uint8Array(256);
{
  const rotl = (x: number, by: number) => ((x << by) | (x >> (8 - by))) & 0xff;
  let p = 1;
  let q = 1;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q = (q ^ (q << 1)) & 0xff;
    q = (q ^ (q << 2)) & 0xff;
    q = (q ^ (q << 4)) & 0xff;
    if (q & 0x80) q ^= 0x09;
    const s = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 0x63;
    SBOX[p] = s;
    INV_SBOX[s] = p;
  } while (p !== 1);
  SBOX[0] = 0x63;
  INV_SBOX[0x63] = 0;
  for (let i = 0; i < 256; i++) {
    M9[i] = times(i, 9);
    M11[i] = times(i, 11);
    M13[i] = times(i, 13);
    M14[i] = times(i, 14);
  }
}

/** Decrypts and removes the padding. Throws when the data is not what this key encrypted. */
export function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length !== 16 || iv.length !== 16 || !data.length || data.length % 16) throw new Error('дані зашифровано інакше');
  // Round keys.
  const rk = new Uint8Array(176);
  rk.set(key);
  for (let i = 16, rcon = 1; i < 176; i += 4) {
    let a = rk[i - 4];
    let b = rk[i - 3];
    let c = rk[i - 2];
    let d = rk[i - 1];
    if (i % 16 === 0) {
      [a, b, c, d] = [SBOX[b] ^ rcon, SBOX[c], SBOX[d], SBOX[a]];
      rcon = xtime(rcon);
    }
    rk[i] = rk[i - 16] ^ a;
    rk[i + 1] = rk[i - 15] ^ b;
    rk[i + 2] = rk[i - 14] ^ c;
    rk[i + 3] = rk[i - 13] ^ d;
  }
  const out = new Uint8Array(data.length);
  const s = new Uint8Array(16);
  const t = new Uint8Array(16);
  for (let at = 0; at < data.length; at += 16) {
    for (let i = 0; i < 16; i++) s[i] = data[at + i] ^ rk[160 + i];
    for (let round = 9; round >= 0; round--) {
      // Rows back to their places and bytes through the inverse table, in one step.
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[c * 4 + r] = INV_SBOX[s[((c - r + 4) % 4) * 4 + r]];
      for (let i = 0; i < 16; i++) t[i] ^= rk[round * 16 + i];
      if (round === 0) {
        s.set(t);
        break;
      }
      for (let c = 0; c < 16; c += 4) {
        const a = t[c];
        const b = t[c + 1];
        const d = t[c + 2];
        const e = t[c + 3];
        s[c] = M14[a] ^ M11[b] ^ M13[d] ^ M9[e];
        s[c + 1] = M9[a] ^ M14[b] ^ M11[d] ^ M13[e];
        s[c + 2] = M13[a] ^ M9[b] ^ M14[d] ^ M11[e];
        s[c + 3] = M11[a] ^ M13[b] ^ M9[d] ^ M14[e];
      }
    }
    for (let i = 0; i < 16; i++) out[at + i] = s[i] ^ (at ? data[at - 16 + i] : iv[i]);
  }
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 16) throw new Error('дані зашифровано інакше');
  return out.subarray(0, out.length - pad);
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('цей браузер застарий для JWPUB: оновіть його');
  const stream = new Blob([data as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** What a publication's texts are encrypted with: derived from what the publication is, the same for every copy. */
const MASK = '11cbb5587e32846d4c26790c633da289f66fe5842a3a585ce1bc3a294af5ada7';
function cipherOf(language: SqlValue, symbol: SqlValue, year: SqlValue, issue: SqlValue): { key: Uint8Array; iv: Uint8Array; card: string } {
  let card = `${language}_${symbol}_${year}`;
  if (Number(issue)) card += `_${Number(issue)}`;
  const material = sha256(new TextEncoder().encode(card)).map((byte, i) => byte ^ parseInt(MASK.slice(i * 2, i * 2 + 2), 16));
  return { key: material.slice(0, 16), iv: material.slice(16), card };
}

// ---- Markup ----
/** Elements that go together with what is inside them. */
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'title', 'head', 'input', 'textarea', 'select', 'button', 'label', 'video', 'audio', 'source', 'track', 'noscript', 'template', 'canvas']);
/**
 * Classes of things that are not text to read: page numbers of the printed edition, the
 * publication's own footnote block (the notes are added from the database), the boxes for typing
 * an answer under a study question, and words meant only for a screen reader.
 */
const DROP_CLASSES = ['pageNum', 'groupFootnote', 'gen-field', 'dc-screenReaderText'];
const IMAGE_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const squeeze = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

const STYLE = `body { line-height: 1.5; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.2em 0 0.6em; }
h1 { font-size: 1.5em; } h2 { font-size: 1.25em; } h3 { font-size: 1.1em; }
p { margin: 0.6em 0; }
img { max-width: 100%; height: auto; }
figure { margin: 1em 0; text-align: center; }
figcaption { font-size: 0.9em; }
table { border-collapse: collapse; margin: 1em auto; max-width: 100%; } td, th { border: 1px solid #888; padding: 2px 6px; vertical-align: top; }
ul, ol { padding-left: 1.4em; }
p.qu { font-size: 0.92em; font-weight: bold; }
p.themeScrp { text-align: center; font-style: italic; }
.du-textAlign--center { text-align: center; }
a.note { vertical-align: super; font-size: 0.75em; line-height: 0; text-decoration: none; padding: 0 0.1em; }
div.footnotes { margin-top: 2em; padding-top: 0.6em; border-top: 1px solid #888; font-size: 0.9em; }
div.footnote { margin: 0.5em 0; }
div.footnote > span.mark { font-weight: bold; margin-right: 0.3em; }
div.footnote > p:first-of-type { display: inline; }
span.vl { vertical-align: super; font-size: 0.7em; line-height: 0; font-weight: bold; margin-right: 0.15em; }
span.cl { font-size: 1.6em; font-weight: bold; margin-right: 0.2em; }
p.sl, p.sz { margin: 0; } p.sz { margin-left: 1.5em; }
`;

export interface JwpubBook {
  epub: Blob;
  title: string;
  author: string;
}

interface Part {
  file: string;
  title: string;
  /** Where the footnotes of this part are filed: its document, or the document of its Bible book. */
  document: number;
  /** The text as stored, still encrypted. */
  content: SqlValue;
  /** A heading put above the text (a Bible chapter has none of its own). */
  heading?: string;
  bible?: boolean;
}

/** Converts a JWPUB publication into an EPUB. The result depends only on the input, byte for byte. */
export async function jwpubToEpub(bytes: Uint8Array): Promise<JwpubBook> {
  const outer = await JSZip.loadAsync(bytes).catch(() => null);
  if (!outer) throw new Error('файл JWPUB пошкоджено: це не архів');
  let manifest: { publication?: { fileName?: string; title?: string; images?: { fileName?: string; type?: string; width?: number; height?: number }[] } } = {};
  try {
    manifest = JSON.parse((await outer.file('manifest.json')?.async('string')) ?? '{}');
  } catch {
    // The database says the same things; the manifest is only a shortcut.
  }
  const contents = outer.file('contents');
  const inner = contents ? await JSZip.loadAsync(await contents.async('uint8array')).catch(() => null) : outer;
  if (!inner) throw new Error('файл JWPUB пошкоджено: вміст не відкривається');
  const entries = Object.values(inner.files).filter((f) => !f.dir);
  const named = manifest.publication?.fileName;
  const dbEntry = (named && inner.file(named)) || entries.find((f) => /\.db$/i.test(f.name));
  if (!dbEntry) throw new Error('у файлі JWPUB немає бази даних видання');
  const db = new SqliteFile(await dbEntry.async('uint8array'));

  const publication = db.rows('Publication', ['MepsLanguageIndex', 'Symbol', 'Year', 'IssueTagNumber', 'Title', 'ShortTitle']).next().value;
  if (!publication) throw new Error('у файлі JWPUB немає опису видання');
  const cipher = cipherOf(publication.MepsLanguageIndex, publication.Symbol, publication.Year, publication.IssueTagNumber);
  const parser = new DOMParser();
  const parse = (html: string) => parser.parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
  const plain = (value: SqlValue) => (typeof value === 'string' ? squeeze(/[<&]/.test(value) ? parse(value).body.textContent : value) : '');
  /** A stored text as HTML; null when there is none. Home-made files sometimes keep it as it is. */
  const decode = async (content: SqlValue): Promise<string | null> => {
    if (typeof content === 'string') return content;
    if (!(content instanceof Uint8Array) || !content.length) return null;
    return new TextDecoder().decode(await inflate(aesCbcDecrypt(cipher.key, cipher.iv, content)));
  };
  // The issues of a magazine all carry the title of the year's volume; an issue's own title tells them apart.
  const issue = db.rows('PublicationIssueProperty', ['Title']).next().value;
  const title = plain(issue?.Title ?? null) || plain(publication.Title) || squeeze(manifest.publication?.title) || plain(publication.ShortTitle) || 'Без назви';

  // ---- What there is to read, in reading order ----
  const documents = [...db.rows('Document', ['DocumentId', 'MepsDocumentId', 'Title', 'TocTitle', 'Content'])]
    .filter((d): d is typeof d & { DocumentId: number } => typeof d.DocumentId === 'number')
    .sort((a, b) => a.DocumentId - b.DocumentId);
  const books = [...db.rows('BibleBook', ['BibleBookId', 'BookDocumentId', 'BookDisplayTitle', 'ChapterDisplayTitle'])].filter((b): b is typeof b & { BibleBookId: number } => typeof b.BibleBookId === 'number');
  const chapters = new Map<number, { number: number; content: SqlValue }[]>();
  for (const row of db.rows('BibleChapter', ['BookNumber', 'ChapterNumber', 'Content'])) {
    if (typeof row.BookNumber !== 'number' || typeof row.ChapterNumber !== 'number' || !row.Content) continue;
    if (!chapters.has(row.BookNumber)) chapters.set(row.BookNumber, []);
    chapters.get(row.BookNumber)!.push({ number: row.ChapterNumber, content: row.Content });
  }
  for (const list of chapters.values()) list.sort((a, b) => a.number - b.number);
  const documentTitle = new Map(documents.map((d) => [d.DocumentId, plain(d.TocTitle) || plain(d.Title)]));
  const bookName = (book: (typeof books)[number]) => plain(book.BookDisplayTitle) || plain(book.ChapterDisplayTitle) || (typeof book.BookDocumentId === 'number' && documentTitle.get(book.BookDocumentId)) || String(book.BibleBookId);
  const bookOfDocument = new Map(books.filter((b) => typeof b.BookDocumentId === 'number' && chapters.has(b.BibleBookId)).map((b) => [b.BookDocumentId as number, b]));
  const chapterFile = (book: number, chapter: number) => `b${String(book).padStart(2, '0')}c${String(chapter).padStart(3, '0')}.xhtml`;

  const parts: Part[] = [];
  /** The file a document starts in, to point links and the table of contents at. */
  const fileOfDocument = new Map<number, string>();
  const placed = new Set<number>();
  const placeBook = (book: (typeof books)[number]) => {
    placed.add(book.BibleBookId);
    const name = plain(book.ChapterDisplayTitle) || bookName(book);
    const document = typeof book.BookDocumentId === 'number' ? book.BookDocumentId : -1;
    for (const chapter of chapters.get(book.BibleBookId) ?? []) {
      const heading = `${name} ${chapter.number}`;
      parts.push({ file: chapterFile(book.BibleBookId, chapter.number), title: heading, document, content: chapter.content, heading, bible: true });
    }
  };
  for (const [n, d] of documents.entries()) {
    const book = bookOfDocument.get(d.DocumentId);
    if (book) {
      // A Bible book is read by its chapters; its own document is only the entry to them.
      fileOfDocument.set(d.DocumentId, chapterFile(book.BibleBookId, chapters.get(book.BibleBookId)![0].number));
      placeBook(book);
    } else if (d.Content) {
      const file = `d${String(n + 1).padStart(4, '0')}.xhtml`;
      fileOfDocument.set(d.DocumentId, file);
      parts.push({ file, title: documentTitle.get(d.DocumentId) ?? '', document: d.DocumentId, content: d.Content });
    }
  }
  for (const book of books) if (!placed.has(book.BibleBookId) && chapters.has(book.BibleBookId)) placeBook(book);
  if (!parts.length) throw new Error('у файлі JWPUB немає тексту');
  const isBible = chapters.size > 0;
  const fileOfMeps = new Map<number, string>();
  for (const d of documents) if (typeof d.MepsDocumentId === 'number' && fileOfDocument.has(d.DocumentId)) fileOfMeps.set(d.MepsDocumentId, fileOfDocument.get(d.DocumentId)!);
  const bookOfMeps = new Map<number, number>();
  for (const d of documents) if (typeof d.MepsDocumentId === 'number' && bookOfDocument.has(d.DocumentId)) bookOfMeps.set(d.MepsDocumentId, bookOfDocument.get(d.DocumentId)!.BibleBookId);

  // ---- Footnotes: by document, then by the number their mark in the text carries ----
  const footnotes = new Map<number, Map<number, SqlValue>>();
  for (const row of db.rows('Footnote', ['DocumentId', 'FootnoteIndex', 'Content'])) {
    if (typeof row.DocumentId !== 'number' || typeof row.FootnoteIndex !== 'number' || !row.Content) continue;
    if (!footnotes.has(row.DocumentId)) footnotes.set(row.DocumentId, new Map());
    footnotes.get(row.DocumentId)!.set(row.FootnoteIndex, row.Content);
  }

  // ---- Pictures: only those the text shows ----
  const media = new Map(entries.filter((f) => f !== dbEntry).map((f) => [f.name.split('/').pop()!.toLowerCase(), f]));
  const pictures = new Map<string, string>();
  const picture = (source: string): string | null => {
    let name = source.replace(/^jwpub-media:\/\//i, '').split(/[\\/?#]/).filter(Boolean).pop() ?? '';
    try {
      name = decodeURIComponent(name);
    } catch {
      // Not percent-encoded after all.
    }
    const key = name.toLowerCase();
    const type = IMAGE_TYPES[key.split('.').pop() ?? ''];
    if (!type || !media.has(key)) return null;
    if (!pictures.has(key)) pictures.set(key, `images/${key.replace(/[^\w.-]/g, '_')}`);
    return pictures.get(key)!;
  };

  /** A jwpub:// link as a place in this book: "zk:<file>#<anchor>", or null when it leads outside. */
  const target = (href: string): string | null => {
    const doc = /^jwpub:\/\/p\/[^:/]+:(\d+)(?:\/(\d+))?/i.exec(href);
    if (doc) {
      const file = fileOfMeps.get(Number(doc[1]));
      return file ? `zk:${file}${doc[2] && !bookOfMeps.has(Number(doc[1])) ? `#p${doc[2]}` : ''}` : null;
    }
    // A verse: in a Bible it is here; anywhere else the verses are not in the file.
    const verse = /^jwpub:\/\/b\/[^/]+\/(\d+):(\d+):(\d+)/i.exec(href);
    if (verse && isBible) return `zk:${chapterFile(Number(verse[1]), Number(verse[2]))}#v${Number(verse[1])}-${Number(verse[2])}-${Number(verse[3])}`;
    const chapter = /^jwpub:\/\/c\/[^:/]+:(\d+)\/(\d+):(\d+)/i.exec(href);
    const book = chapter ? bookOfMeps.get(Number(chapter[1])) : undefined;
    if (chapter && book !== undefined) return `zk:${chapterFile(book, Number(chapter[2]))}#v${book}-${Number(chapter[2])}-${Number(chapter[3])}`;
    return null;
  };

  /** Makes parsed publication markup safe, self-contained and fit to be written out as XHTML. */
  const tidy = (root: Element, part: Part, marks: Map<number, Element[]> | null) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (!root.contains(el)) continue;
      const name = el.localName;
      const cls = classes(el);
      // Besides the above: cross-reference marks, and hidden reading aids of a Bible.
      if (DROP.has(name) || DROP_CLASSES.some((c) => cls.includes(c)) || el.hasAttribute('data-rel-fnid') || (el.hasAttribute('data-mid') && (part.bible || cls.includes('m'))) || (part.bible && cls.includes('tt'))) {
        el.remove();
        continue;
      }
      if (!/^[a-z][a-z0-9]*$/.test(name) || name === 'form' || name === 'html' || name === 'body') {
        el.replaceWith(...Array.from(el.childNodes));
        continue;
      }
      const note = el.getAttribute('data-fnid');
      const href = el.getAttribute('href');
      for (const attr of Array.from(el.attributes)) {
        const key = attr.name.toLowerCase();
        if (!/^[a-z][a-z0-9-]*$/.test(key) || key.startsWith('on') || key.startsWith('data-') || key === 'srcset' || key === 'contenteditable' || key === 'target') el.removeAttribute(attr.name);
      }
      if (name === 'img') {
        const file = picture(el.getAttribute('src') ?? '');
        if (!file) {
          el.remove();
          continue;
        }
        el.setAttribute('src', file);
        if (!el.hasAttribute('alt')) el.setAttribute('alt', '');
        continue;
      }
      if (note !== null && marks && /^\d+$/.test(note)) {
        // A footnote mark. Its link is made once it is known whether the note exists.
        const mark = el.ownerDocument.createElement('a');
        mark.append(...Array.from(el.childNodes));
        if (!squeeze(mark.textContent)) mark.textContent = '*';
        el.replaceWith(mark);
        if (!marks.has(Number(note))) marks.set(Number(note), []);
        marks.get(Number(note))!.push(mark);
        continue;
      }
      if (name === 'a' && href !== null) {
        if (/^jwpub:/i.test(href)) {
          const to = target(href);
          if (to) el.setAttribute('href', to);
          else {
            // A link to another publication or to a verse: the words stay, the link cannot.
            const words = el.ownerDocument.createElement('span');
            if (cls.join('')) words.setAttribute('class', cls.join(' '));
            words.append(...Array.from(el.childNodes));
            el.replaceWith(words);
          }
        } else if (!/^(https?:|mailto:|#)/i.test(href.trim())) el.removeAttribute('href');
      }
    }
  };

  const serializer = new XMLSerializer();
  const write = (root: Element) =>
    Array.from(root.childNodes)
      .map((node) => (node.nodeType === 1 ? serializer.serializeToString(node) : node.nodeType === 3 && node.nodeValue?.trim() ? `<p>${escapeText(node.nodeValue)}</p>` : ''))
      .join('\n');

  // ---- Text ----
  const files: { name: string; title: string; body: string }[] = [];
  let sample = '';
  for (const part of parts) {
    let html: string | null;
    try {
      html = await decode(part.content);
    } catch {
      throw new Error('текст видання не розшифровується: файл JWPUB пошкоджено або він новішого зразка');
    }
    if (!html) continue;
    const doc = parse(html);
    const marks = new Map<number, Element[]>();
    tidy(doc.body, part, marks);
    if (!squeeze(doc.body.textContent) && !doc.body.querySelector('img')) continue;
    if (part.bible) {
      // A verse set in several pieces has an id per piece (v1-1-1-1, v1-1-1-2); links name the verse.
      for (const piece of Array.from(doc.body.querySelectorAll('[id]'))) {
        const verse = /^(v\d+-\d+-\d+)-\d+$/.exec(piece.id)?.[1];
        if (!verse || doc.getElementById(verse)) continue;
        const anchor = doc.createElement('span');
        anchor.id = verse;
        piece.before(anchor);
      }
    }
    if (sample.length < 3000) sample += ` ${squeeze(doc.body.textContent).slice(0, 3000)}`;

    // Footnotes go under the text they belong to; a touch on the mark shows the note in place.
    const mine = footnotes.get(part.document);
    const numbers = part.bible ? [...marks.keys()] : [...new Set([...(mine?.keys() ?? []), ...marks.keys()])];
    const notes: string[] = [];
    for (const number of numbers.sort((a, b) => a - b)) {
      const text = await decode(mine?.get(number) ?? null).catch(() => null);
      const found = marks.get(number) ?? [];
      if (!text) {
        for (const mark of found) mark.replaceWith(...Array.from(mark.childNodes));
        continue;
      }
      found.forEach((mark, i) => {
        mark.setAttribute('class', 'note');
        mark.setAttribute('href', `#fn${number}`);
        if (i === 0) mark.setAttribute('id', `fnref${number}`);
      });
      const noteDoc = parse(text);
      tidy(noteDoc.body, part, null);
      // A note numbers its paragraphs from where the text's own numbers are already taken.
      for (const el of Array.from(noteDoc.body.querySelectorAll('[id]'))) el.removeAttribute('id');
      const symbol = squeeze(found[0]?.textContent) || '*';
      notes.push(`<div class="footnote" id="fn${number}"><span class="mark">${found.length ? `<a href="#fnref${number}">${escapeText(symbol)}</a>` : escapeText(symbol)}</span> ${write(noteDoc.body)}</div>`);
    }
    const heading = part.heading ? `<h2>${escapeText(part.heading)}</h2>\n` : '';
    files.push({ name: part.file, title: part.title || title, body: `${heading}${write(doc.body)}${notes.length ? `\n<div class="footnotes">\n${notes.join('\n')}\n</div>` : ''}` });
  }
  if (!files.length) throw new Error('у файлі JWPUB немає тексту');

  // Links inside the book: to the file their target ended up in, or plain text when it is not there.
  const written = new Set(files.map((f) => f.name));
  for (const file of files) {
    file.body = file.body.replace(/ href="zk:([^"#]*)(#[^"]*)?"/g, (_, name: string, anchor = '') => (written.has(name) ? ` href="${name === file.name && anchor ? '' : name}${anchor}"` : ''));
  }

  // ---- Table of contents: the publication's own tree, else its documents in order ----
  const titleOfFile = new Map(files.map((f) => [f.name, f.title]));
  const toc: EpubToc[] = [];
  /** A Bible book in the list: its name, then its chapters one level down. */
  const listBook = (book: (typeof books)[number], depth: number) => {
    const list = (chapters.get(book.BibleBookId) ?? []).filter((c) => written.has(chapterFile(book.BibleBookId, c.number)));
    if (!list.length) return;
    toc.push({ title: bookName(book), href: chapterFile(book.BibleBookId, list[0].number), depth });
    // The chapter's entry carries the book's name too: it is what the reader shows as "where I am".
    if (list.length > 1) for (const c of list) toc.push({ title: `${bookName(book)} ${c.number}`, href: chapterFile(book.BibleBookId, c.number), depth: depth + 1 });
  };
  const views = [...db.rows('PublicationView', ['PublicationViewId', 'Symbol'])];
  const view = (views.find((v) => v.Symbol === 'jwpub') ?? views[0])?.PublicationViewId;
  const items = [...db.rows('PublicationViewItem', ['PublicationViewItemId', 'PublicationViewId', 'ParentPublicationViewItemId', 'Title', 'DefaultDocumentId'])].filter(
    (item) => typeof item.PublicationViewItemId === 'number' && (view === undefined || item.PublicationViewId === view || item.PublicationViewId === null),
  );
  const firstDocument = new Map<number, number>();
  for (const row of db.rows('PublicationViewItemDocument', ['PublicationViewItemId', 'DocumentId'])) {
    if (typeof row.PublicationViewItemId === 'number' && typeof row.DocumentId === 'number' && !firstDocument.has(row.PublicationViewItemId)) firstDocument.set(row.PublicationViewItemId, row.DocumentId);
  }
  const ids = new Set(items.map((item) => item.PublicationViewItemId));
  const children = new Map<SqlValue, typeof items>();
  for (const item of items) {
    const parent = ids.has(item.ParentPublicationViewItemId) ? item.ParentPublicationViewItemId : -1;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(item);
  }
  const listedBooks = new Set<number>();
  const list = (parent: SqlValue, depth: number): void => {
    if (depth > 8) return;
    for (const item of children.get(parent) ?? []) {
      const id = item.PublicationViewItemId as number;
      const document = typeof item.DefaultDocumentId === 'number' && item.DefaultDocumentId >= 0 ? item.DefaultDocumentId : firstDocument.get(id);
      const book = document === undefined ? undefined : bookOfDocument.get(document);
      const file = document === undefined ? undefined : fileOfDocument.get(document);
      const before = toc.length;
      if (book) {
        listedBooks.add(book.BibleBookId);
        listBook(book, depth);
        continue;
      }
      if (file && written.has(file)) toc.push({ title: plain(item.Title) || titleOfFile.get(file) || title, href: file, depth });
      else toc.push({ title: plain(item.Title), href: '', depth });
      const own = toc[before];
      list(id, depth + 1);
      // A heading with nothing to open leads to the first thing under it, or is left out.
      if (!own.href) {
        const under = toc.slice(before + 1).find((entry) => entry.href);
        if (under && own.title) own.href = under.href;
        else toc.splice(before, 1);
      }
    }
  };
  list(-1, 1);
  // One root that only wraps everything else says nothing: the list starts a level lower.
  for (let guard = 0; guard < 4 && toc.length > 1 && toc.filter((entry) => entry.depth === 1).length === 1; guard++) {
    if (toc[0].href === toc[1].href) toc.shift();
    else toc[0].depth = 2;
    for (const entry of toc) entry.depth = Math.max(1, entry.depth - 1);
  }
  // Bible books the tree does not mention are still worth finding.
  if (toc.length >= 2) for (const book of books) if (!listedBooks.has(book.BibleBookId)) listBook(book, 1);
  if (toc.length < 2) {
    toc.length = 0;
    const shown = new Set<number>();
    for (const part of parts) {
      if (!written.has(part.file)) continue;
      const book = part.bible ? books.find((b) => (typeof b.BookDocumentId === 'number' ? b.BookDocumentId : -1) === part.document && chapters.has(b.BibleBookId)) : undefined;
      if (!part.bible) toc.push({ title: part.title || title, href: part.file, depth: 1 });
      else if (book && !shown.has(book.BibleBookId)) {
        shown.add(book.BibleBookId);
        listBook(book, 1);
      }
    }
  }

  // ---- Pictures and the cover ----
  const rank = (type: string | undefined) => (type === 'c' ? 2 : type === 't' ? 1 : 0);
  const candidates = (manifest.publication?.images ?? [])
    .filter((image) => typeof image.fileName === 'string' && media.has(image.fileName.toLowerCase()))
    // The printed cover ("c") when the file has it, else the square tile ("t"), else the largest picture.
    .sort((a, b) => rank(b.type) - rank(a.type) || (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  const cover = candidates.length ? picture(candidates[0].fileName!) : null;
  const images: { file: string; type: string; data: Uint8Array }[] = [];
  for (const [key, file] of [...pictures].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    images.push({ file, type: IMAGE_TYPES[key.split('.').pop()!], data: await media.get(key)!.async('uint8array') });
  }

  const epub = await buildEpub({
    id: `urn:jwpub:${cipher.card}`,
    title,
    authors: [],
    lang: guessLang(sample),
    css: STYLE,
    files,
    images,
    cover: cover ?? undefined,
    toc,
  });
  return { epub, title, author: '' };
}

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
