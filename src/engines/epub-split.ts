// Cutting oversized chapter files of an EPUB into chapters.
//
// A reader lays out, measures and paints a book one file at a time. Most books come as a file per
// chapter; some come with the whole text in one (Leanpub and Pandoc make such books). Then "a
// chapter" is 1 200 pages: seconds to open or to change the font size, a repaint of all of it at
// every page turn, and the chapter title, the page count and "this chapter" for the assistant all
// mean the entire book.
//
// So on the way into the library such files are cut into parts — at chapter headings where there
// are any, by size where there are none — and the contents, the links and the package file are
// pointed at the parts. Nothing else in the book is touched, and a book without such files is left
// exactly as it came. The result depends only on the input: the same book is cut the same way on
// every device, so places and notes in it still meet when devices sync.
import JSZip from 'jszip';

/**
 * Names the way books are cut. Places in a book (reading position, highlights) are counted in its
 * files, so a book cut another way is another book: change this whenever the same file would come
 * out in different parts — another limit, other rules for where a part starts.
 */
export const CUT_VERSION = 'cut1';

/** How much markup (characters, roughly) a chapter file may hold before it is cut. */
const LIMIT = 250_000;
/** Where chapters are small — a glossary, a book of verses — they are kept together up to this much. */
const SMALL_PARTS = 16_000;

const XHTML_TYPE = 'application/xhtml+xml';
const DATE = new Date(Date.UTC(2000, 0, 1));

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const decode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
/** A path inside the archive from the directory of the file that refers to it and the reference. */
function resolve(dir: string, href: string): string | null {
  try {
    const url = new URL(href, `http://book/${encodeURI(dir)}`);
    return url.host === 'book' ? decode(url.pathname.slice(1)) : null;
  } catch {
    return null;
  }
}
/** `chapter.xhtml` → `chapter-zk002.xhtml`; works on a path and on a reference to it alike. */
const withTag = (path: string, tag: string) => path.replace(/(\.[^./\\]*)?$/, (ext) => `${tag}${ext}`);
const unescapeXml = (text: string) => text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const elementsNamed = (root: Document | Element, name: string) => Array.from(root.getElementsByTagNameNS('*', name));
const broken = (doc: Document) => doc.getElementsByTagName('parsererror').length > 0;

/** The text of a file of the archive, when it is UTF-8 (anything else is left alone). */
async function readText(entry: JSZip.JSZipObject): Promise<string | null> {
  const bytes = await entry.async('uint8array');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const declared = /^<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/i.exec(text)?.[1];
    return declared && !/^utf-?8$/i.test(declared) ? null : text;
  } catch {
    return null;
  }
}

// ---- Where to cut ----

/** Elements that only hold other blocks: a cut may fall between their children. */
const HOLDERS = new Set(['body', 'div', 'section', 'article', 'main']);

/** About how much markup an element is. */
const weigh = (el: Element) => (el.textContent?.length ?? 0) + 20 * (el.getElementsByTagName('*').length + 1);

const headingLevel = (el: Element | null | undefined) => {
  const m = el ? /^h([1-6])$/.exec(el.localName) : null;
  return m ? Number(m[1]) : Infinity;
};
/** What an element opens: 1 for a section of the text, the level of the heading it is or starts with, otherwise nothing. */
function leadOf(el: Element): number {
  if (el.localName === 'section' || el.localName === 'article') return 1;
  if (el.localName === 'div' || el.localName === 'header') return headingLevel(el.firstElementChild);
  return headingLevel(el);
}

/** A stretch of the text that stays in one piece. */
interface Atom {
  node: Node;
  size: number;
  /** A chapter (or, inside an oversized chapter, a section of it) starts here. */
  opens: boolean;
  heading: boolean;
}

/** The text under `holder` as pieces in reading order; an oversized holder inside it is taken apart in turn. */
function atomsOf(holder: Element, out: Atom[]): void {
  const kids = Array.from(holder.childNodes);
  const leads = kids.map((kid) => (kid.nodeType === Node.ELEMENT_NODE ? leadOf(kid as Element) : Infinity));
  // The highest rank among the children is what opens a part here: chapters, not their subsections.
  const top = leads.reduce((least, lead) => Math.min(least, lead), Infinity);
  kids.forEach((kid, i) => {
    const opens = top <= 3 && leads[i] === top;
    if (kid.nodeType === Node.TEXT_NODE) {
      const text = (kid as Text).data;
      if (text.trim()) out.push({ node: kid, size: text.length, opens: false, heading: false });
      return;
    }
    if (kid.nodeType !== Node.ELEMENT_NODE) return;
    const el = kid as Element;
    const size = weigh(el);
    if (size > LIMIT && HOLDERS.has(el.localName) && el.firstElementChild) {
      const from = out.length;
      atomsOf(el, out);
      if (opens && out[from]) out[from].opens = true;
      return;
    }
    out.push({ node: el, size, opens, heading: leads[i] <= 6 });
  });
}

const isBlank = (node: Node) => node.nodeType === Node.COMMENT_NODE || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE || (node.nodeType === Node.TEXT_NODE && !(node as Text).data.trim());
/** Whether nothing but white space comes before the node inside its parent. */
function isFirstIn(node: Node): boolean {
  for (let prev = node.previousSibling; prev; prev = prev.previousSibling) if (!isBlank(prev)) return false;
  return true;
}

/** The nodes before which the body is cut, in reading order; empty when it is fine as it is. */
function cutPoints(body: Element): Node[] {
  const atoms: Atom[] = [];
  atomsOf(body, atoms);
  const total = atoms.reduce((sum, a) => sum + a.size, 0);
  if (total <= LIMIT || atoms.length < 2) return [];

  // Chapters first. Where they are tiny on average, several go into one part.
  const chapters = atoms.filter((a) => a.opens).length;
  const least = chapters && total / chapters < 4000 ? SMALL_PARTS : 1;
  const runs: Atom[][] = [[]];
  let size = 0;
  for (const atom of atoms) {
    if (atom.opens && size >= least) {
      runs.push([]);
      size = 0;
    }
    runs[runs.length - 1].push(atom);
    size += atom.size;
  }

  // Then what is still too long is cut into even parts, at a heading when one is close.
  const starts: Node[] = [];
  for (const run of runs) {
    if (!run.length) continue;
    starts.push(run[0].node);
    const whole = run.reduce((sum, a) => sum + a.size, 0);
    if (whole <= LIMIT) continue;
    const share = whole / Math.ceil(whole / LIMIT);
    let filled = 0;
    for (const atom of run) {
      if (filled > 0 && (filled + atom.size / 2 > share || (atom.heading && filled > share * 0.75))) {
        starts.push(atom.node);
        filled = 0;
      }
      filled += atom.size;
    }
  }

  const cuts: Node[] = [];
  for (let node of starts.slice(1)) {
    // A part that starts with the first thing in a section starts with the section itself, or an
    // empty copy of the section would be left at the end of the part before it.
    while (node.parentNode && node.parentNode !== body && isFirstIn(node)) node = node.parentNode;
    if (node.parentNode === body && isFirstIn(node)) continue;
    if (cuts[cuts.length - 1] !== node) cuts.push(node);
  }
  return cuts;
}

// ---- Cutting one file ----

interface Split {
  /** The file's path in the archive; the first part keeps it. */
  path: string;
  /** The parts as documents, in reading order. */
  docs: Document[];
  /** Which part an anchor of the file is in now. */
  anchors: Map<string, number>;
}

function splitDocument(path: string, text: string): Split | null {
  const doc = new DOMParser().parseFromString(text, XHTML_TYPE);
  if (broken(doc)) return null;
  const body = elementsNamed(doc, 'body')[0];
  if (!body) return null;
  const cuts = cutPoints(body);
  if (!cuts.length) return null;

  // Taking the text out from the front, part by part: a section that a cut falls into is copied
  // (tag and attributes) into the part that ends there and goes on in the part that follows.
  const pieces: DocumentFragment[] = [];
  const range = doc.createRange();
  for (const cut of cuts) {
    range.setStart(body, 0);
    range.setEndBefore(cut);
    pieces.push(range.extractContents());
  }
  range.selectNodeContents(body);
  pieces.push(range.extractContents());
  // A piece with nothing to show (a cut fell between two empty elements) joins its neighbour.
  const shows = (piece: DocumentFragment) => Boolean((piece.textContent ?? '').trim() || piece.querySelector('img, svg, video, audio, object, canvas, math, hr'));
  const filled: DocumentFragment[] = [];
  let carried: DocumentFragment | null = null;
  for (const piece of pieces) {
    if (carried) piece.prepend(carried);
    carried = null;
    if (shows(piece)) filled.push(piece);
    else carried = piece;
  }
  if (carried && filled.length) filled[filled.length - 1].append(carried);
  if (filled.length < 2) return null;

  // What is left is the file without its text: the frame every part is put into.
  const docs = filled.map((piece) => {
    const part = doc.cloneNode(true) as Document;
    elementsNamed(part, 'body')[0].append(part.adoptNode(piece));
    return part;
  });
  const anchors = new Map<string, number>();
  docs.forEach((part, k) => {
    for (const el of Array.from(part.querySelectorAll('[id], a[name]'))) {
      const id = el.getAttribute('id') ?? el.getAttribute('name');
      if (id && !anchors.has(id)) anchors.set(id, k);
    }
  });
  return { path, docs, anchors };
}

// ---- The book ----

/**
 * The same book with its oversized chapter files cut into chapters; null when there is nothing to
 * cut (or the book is not one this can be done to: fixed pages, a package that cannot be read).
 */
export async function splitLargeChapters(epub: Blob): Promise<Blob | null> {
  const zip = await JSZip.loadAsync(await epub.arrayBuffer());
  const container = zip.file('META-INF/container.xml');
  if (!container) return null;
  const opfPath = /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(await container.async('string'))?.[1];
  const opfEntry = opfPath ? zip.file(unescapeXml(opfPath)) : null;
  const opfText = opfEntry ? await readText(opfEntry) : null;
  if (!opfEntry || opfText === null) return null;
  const opf = new DOMParser().parseFromString(opfText, 'application/xml');
  if (broken(opf)) return null;
  // Pages drawn to measure are not text that flows: nothing to cut.
  if (elementsNamed(opf, 'meta').some((m) => m.getAttribute('property') === 'rendition:layout' && m.textContent?.trim() === 'pre-paginated')) return null;

  const opfDir = dirOf(opfEntry.name);
  const items = elementsNamed(opf, 'item');
  const itemIds = new Set(items.map((item) => item.getAttribute('id') ?? ''));
  const refs = elementsNamed(opf, 'itemref');

  const splits: { split: Split; item: Element; ref: Element; tag: string }[] = [];
  for (const ref of refs) {
    const idref = ref.getAttribute('idref');
    const item = items.find((it) => it.getAttribute('id') === idref);
    const href = item?.getAttribute('href');
    if (!item || !href || item.getAttribute('media-type') !== XHTML_TYPE) continue;
    // The contents page is a list, read aloud narration is tied to the file, and a file shown twice is somebody's design.
    if (/\bnav\b/.test(item.getAttribute('properties') ?? '') || item.hasAttribute('media-overlay')) continue;
    if (/pre-paginated/.test(ref.getAttribute('properties') ?? '') || refs.filter((r) => r.getAttribute('idref') === idref).length > 1) continue;
    const path = resolve(opfDir, href);
    const entry = path ? zip.file(path) : null;
    if (!path || !entry || splits.some((s) => s.split.path === path)) continue;
    // A file's size in bytes is never less than its length in characters: most are passed over unread.
    const bytes = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof bytes === 'number' && bytes <= LIMIT) continue;
    const text = await readText(entry);
    if (text === null || text.length <= LIMIT) continue;
    const split = splitDocument(path, text);
    if (!split) continue;
    // Names for the parts that no file of the book has yet.
    let tag = '-zk';
    const taken = (t: string) => split.docs.some((_, k) => k > 0 && zip.file(withTag(path, partTag(t, k))));
    while (taken(tag)) tag += 'x';
    splits.push({ split, item, ref, tag });
  }
  if (!splits.length) return null;

  // ---- The parts themselves, their own links mended ----
  const serializer = new XMLSerializer();
  for (const { split, tag } of splits) {
    const dir = dirOf(split.path);
    const nameOf = (k: number) => baseOf(k ? withTag(split.path, partTag(tag, k)) : split.path);
    split.docs.forEach((part, k) => {
      for (const link of Array.from(part.querySelectorAll('[href]'))) {
        const href = link.getAttribute('href') ?? '';
        const hash = href.indexOf('#');
        if (hash < 0) continue;
        // A link within the file (written as "#note" or with the file's own name) to something now in another part.
        if (hash > 0 && resolve(dir, href.slice(0, hash)) !== split.path) continue;
        const target = split.anchors.get(decode(href.slice(hash + 1)));
        if (target === undefined || (target === k && hash === 0)) continue;
        link.setAttribute('href', `${target === k ? '' : encodeURI(nameOf(target))}${href.slice(hash)}`);
      }
      const xml = serializer.serializeToString(part).replace(/^\s*<\?xml[^>]*\?>\s*/, '');
      zip.file(k ? withTag(split.path, partTag(tag, k)) : split.path, `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`, { date: DATE, compression: 'DEFLATE' });
    });
  }

  // ---- The package: a file and a place in the reading order for every part ----
  for (const { split, item, ref, tag } of splits) {
    let afterItem = item;
    let afterRef = ref;
    for (let k = 1; k < split.docs.length; k++) {
      let id = `${item.getAttribute('id')}${partTag(tag, k)}`;
      while (itemIds.has(id)) id += '_';
      itemIds.add(id);
      const partItem = item.cloneNode(false) as Element;
      partItem.setAttribute('id', id);
      partItem.setAttribute('href', withTag(item.getAttribute('href')!, partTag(tag, k)));
      afterItem.after(partItem);
      afterItem = partItem;
      const partRef = ref.cloneNode(false) as Element;
      partRef.removeAttribute('id');
      partRef.setAttribute('idref', id);
      afterRef.after(partRef);
      afterRef = partRef;
    }
  }
  const pathsSplit = new Map(splits.map((s) => [s.split.path, s]));
  const newOpf = `<?xml version="1.0" encoding="UTF-8"?>\n${serializer.serializeToString(opf).replace(/^\s*<\?xml[^>]*\?>\s*/, '')}`;

  // ---- Everything that points into a file that was cut: the contents, other chapters, the package's guide ----
  const repoint = (text: string, dir: string) =>
    text.replace(/(\s(?:href|src)\s*=\s*)(["'])((?:(?!\2).)*)\2/g, (whole, before: string, quote: string, value: string) => {
      const hash = value.indexOf('#');
      if (hash <= 0) return whole;
      const path = resolve(dir, unescapeXml(value.slice(0, hash)));
      const hit = path ? pathsSplit.get(path) : undefined;
      const part = hit?.split.anchors.get(decode(unescapeXml(value.slice(hash + 1))));
      return hit && part ? `${before}${quote}${withTag(value.slice(0, hash), partTag(hit.tag, part))}${value.slice(hash)}${quote}` : whole;
    });
  zip.file(opfEntry.name, repoint(newOpf, opfDir), { date: DATE, compression: 'DEFLATE' });
  const names = [...pathsSplit.keys()].flatMap((path) => [baseOf(path), encodeURI(baseOf(path))]);
  for (const item of items) {
    const type = item.getAttribute('media-type');
    if (type !== XHTML_TYPE && type !== 'application/x-dtbncx+xml') continue;
    const path = resolve(opfDir, item.getAttribute('href') ?? '');
    const entry = path && !pathsSplit.has(path) ? zip.file(path) : null;
    if (!path || !entry) continue;
    const text = await readText(entry);
    if (text === null || !names.some((name) => text.includes(name))) continue;
    const mended = repoint(text, dirOf(path));
    if (mended !== text) zip.file(path, mended, { date: entry.date, compression: 'DEFLATE' });
  }

  // Files that were stored as they are (pictures, as a rule) stay so; the type marker must.
  zip.forEach((_path, entry) => {
    const stored = (entry as unknown as { _data?: { compression?: { magic?: string } } })._data?.compression?.magic === '\x00\x00';
    if (stored && !entry.options.compression) entry.options.compression = 'STORE';
  });
  const mimetype = zip.file('mimetype');
  if (mimetype) zip.file('mimetype', await mimetype.async('uint8array'), { compression: 'STORE', date: mimetype.date });
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

const partTag = (tag: string, k: number) => `${tag}${String(k + 1).padStart(3, '0')}`;
