// Taking a book out of the app: its file as it is, or a PDF made of it. The PDF is laid out from the
// pages of an EPUB the app composed itself (a book made from a repository): headings, paragraphs,
// lists, code, diffs, tables, pictures — the handful of things such a book consists of. It is made
// on the device; the library that writes PDF and the fonts are loaded when one is first asked for.
import JSZip from 'jszip';
import serifBoldUrl from 'dejavu-fonts-ttf/ttf/DejaVuSerif-Bold.ttf?url';
import serifBoldItalicUrl from 'dejavu-fonts-ttf/ttf/DejaVuSerif-BoldItalic.ttf?url';
import serifItalicUrl from 'dejavu-fonts-ttf/ttf/DejaVuSerif-Italic.ttf?url';
import serifUrl from 'dejavu-fonts-ttf/ttf/DejaVuSerif.ttf?url';
import monoBoldUrl from 'dejavu-fonts-ttf/ttf/DejaVuSansMono-Bold.ttf?url';
import monoUrl from 'dejavu-fonts-ttf/ttf/DejaVuSansMono.ttf?url';
import { db } from '../db';
import type { BookRecord } from '../types';
import { duringWork } from './busy';
import { isIos } from './read-aloud';
import { blobToBase64, canvasToBlob } from './utils';

/** Hands a file to the reader: the share sheet on an iPhone (where it can be saved to Files), a download elsewhere. */
export async function saveBlob(blob: Blob, fileName: string): Promise<void> {
  const file = new File([blob], fileName, { type: blob.type });
  const nav = navigator as Navigator & { canShare?(data: ShareData): boolean };
  if (isIos() && nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const safeName = (title: string) => title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'book';

async function fileOf(book: BookRecord): Promise<Blob> {
  const stored = await db.files.get(book.id);
  if (!stored) throw new Error('Файлу цієї книжки немає на пристрої: відкрийте її, щоб він завантажився зі сховища.');
  return stored.data;
}

/** The book's file as it is kept (for a converted FB2 or MOBI — the EPUB it became). */
export async function downloadBookFile(book: BookRecord): Promise<void> {
  const data = await fileOf(book);
  const ext = book.format === 'djvu' ? 'djvu' : book.format;
  const type = book.format === 'epub' ? 'application/epub+zip' : book.format === 'pdf' ? 'application/pdf' : 'image/vnd.djvu';
  await saveBlob(new Blob([data], { type }), `${safeName(book.title)}.${ext}`);
}

export async function downloadBookPdf(book: BookRecord, onStep: (step: string) => void): Promise<void> {
  const data = await fileOf(book);
  const pdf = await duringWork(epubToPdf(data, book.title, onStep));
  await saveBlob(pdf, `${safeName(book.title)}.pdf`);
}

// ---- EPUB → PDF ----

type Node_ = Record<string, unknown>;
type Content = Node_ | string;

interface PdfMake {
  addVirtualFileSystem(vfs: Record<string, string>): void;
  addFonts(fonts: Record<string, Record<string, string>>): void;
  createPdf(doc: Node_): { getBlob(): Promise<Blob> };
}

let engine: Promise<PdfMake> | null = null;

/** The PDF writer with the fonts a book needs: a serif for text and a monospaced one for code, both with Cyrillic. */
function pdfEngine(): Promise<PdfMake> {
  engine ??= (async () => {
    const fonts = {
      'DejaVuSerif.ttf': serifUrl,
      'DejaVuSerif-Bold.ttf': serifBoldUrl,
      'DejaVuSerif-Italic.ttf': serifItalicUrl,
      'DejaVuSerif-BoldItalic.ttf': serifBoldItalicUrl,
      'DejaVuSansMono.ttf': monoUrl,
      'DejaVuSansMono-Bold.ttf': monoBoldUrl,
    };
    const [module, ...files] = await Promise.all([
      import('pdfmake/build/pdfmake.min.js'),
      ...Object.values(fonts).map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error('Не вдалося завантажити шрифти для PDF. Потрібен інтернет (лише першого разу).');
        return blobToBase64(await res.blob());
      }),
    ]);
    const pdfMake = ((module as { default?: PdfMake }).default ?? module) as PdfMake;
    pdfMake.addVirtualFileSystem(Object.fromEntries(Object.keys(fonts).map((name, i) => [name, files[i]])));
    pdfMake.addFonts({
      Serif: { normal: 'DejaVuSerif.ttf', bold: 'DejaVuSerif-Bold.ttf', italics: 'DejaVuSerif-Italic.ttf', bolditalics: 'DejaVuSerif-BoldItalic.ttf' },
      Mono: { normal: 'DejaVuSansMono.ttf', bold: 'DejaVuSansMono-Bold.ttf', italics: 'DejaVuSansMono.ttf', bolditalics: 'DejaVuSansMono-Bold.ttf' },
    });
    return pdfMake;
  })();
  // A failed load (no network) must not be remembered as the answer.
  engine.catch(() => (engine = null));
  return engine;
}

// A4 in points, the margins, and what follows from them.
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { x: 56, y: 62 };
const TEXT_WIDTH = PAGE.width - MARGIN.x * 2;
const CODE_SIZE = 7.6;
/** Characters of the monospaced font that fit a line of a code block (its advance is 0.602 of the size). */
const CODE_COLUMNS = Math.floor((TEXT_WIDTH - 14) / (CODE_SIZE * 0.602));

/** Signs the serif font lacks (check marks, stars, warning signs): the monospaced one has them. */
const SYMBOLS = /[\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]+/gu;
/** Emoji and what glues them together: no font here has them. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}\u{E0020}-\u{E007F}]/gu;

interface Run {
  bold?: boolean;
  italics?: boolean;
  code?: boolean;
  link?: string;
  color?: string;
  strike?: boolean;
  sup?: boolean;
  sub?: boolean;
}

function textRun(text: string, style: Run): Content[] {
  const clean = text.replace(EMOJI, '');
  if (!clean) return [];
  const base: Node_ = {};
  if (style.bold) base.bold = true;
  if (style.italics) base.italics = true;
  if (style.code) Object.assign(base, { font: 'Mono', fontSize: 9, background: '#eef0f3' });
  if (style.link) Object.assign(base, { link: style.link, color: '#1f5fbf', decoration: 'underline' });
  if (style.color) base.color = style.color;
  if (style.strike) base.decoration = 'lineThrough';
  if (style.sup) base.sup = true;
  if (style.sub) base.sub = true;
  const out: Content[] = [];
  let last = 0;
  for (const m of style.code ? [] : clean.matchAll(SYMBOLS)) {
    if (m.index > last) out.push({ ...base, text: clean.slice(last, m.index) });
    out.push({ ...base, text: m[0], font: 'Mono' });
    last = m.index + m[0].length;
  }
  if (last < clean.length) out.push({ ...base, text: clean.slice(last) });
  return out;
}

/** Breaks a line of code that is longer than the page is wide; the continuation is marked. */
function wrapCode(line: string): string[] {
  if (line.length <= CODE_COLUMNS) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > CODE_COLUMNS) {
    const room = out.length ? CODE_COLUMNS - 2 : CODE_COLUMNS;
    // At a space or a punctuation mark near the edge, when there is one.
    let cut = room;
    for (let i = room; i > room - 24 && i > 8; i--) {
      if (/[\s,;:(){}[\]<>=+\-*/|&.]/.test(rest[i - 1])) {
        cut = i;
        break;
      }
    }
    out.push((out.length ? '↪ ' : '') + rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push((out.length ? '↪ ' : '') + rest);
  return out;
}

interface Picture {
  key: string;
  width: number;
  height: number;
}

interface Build {
  /** Pictures by their path in the EPUB. */
  pictures: Map<string, Picture>;
  /** Directory of the page being laid out, for resolving picture paths. */
  dir: string;
  /** Id of the chapter being laid out: its subheadings go under it in the outline. */
  chapter: string;
  ids: number;
}

const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'pre', 'blockquote', 'table', 'figure', 'figcaption', 'hr', 'details', 'summary', 'img', 'center', 'address']);

function resolvePath(dir: string, href: string): string {
  const stack = dir ? dir.split('/') : [];
  for (const part of decodeURIComponent(href.split('#')[0]).split('/')) {
    if (part === '..') stack.pop();
    else if (part && part !== '.') stack.push(part);
  }
  return stack.join('/');
}

function picture(img: Element, b: Build, maxWidth = TEXT_WIDTH): Content | null {
  const pic = b.pictures.get(resolvePath(b.dir, img.getAttribute('src') ?? ''));
  if (!pic) return null;
  // A diagram says how wide it was drawn; other pictures are shown at their own size. CSS pixels are 0.75 pt.
  const asked = Number(img.getAttribute('width')) || pic.width;
  let width = Math.min(maxWidth, asked * 0.75);
  const maxHeight = PAGE.height - MARGIN.y * 2 - 40;
  if ((width * pic.height) / pic.width > maxHeight) width = (maxHeight * pic.width) / pic.height;
  return { image: pic.key, width, alignment: 'center', margin: [0, 6, 0, 6] };
}

/** Text of an element as runs; pictures met on the way are set aside to follow the text. */
function inlineRuns(node: Node, style: Run, b: Build, aside: Content[], keepSpace = false): Content[] {
  const out: Content[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out.push(...textRun(keepSpace ? (child.nodeValue ?? '') : (child.nodeValue ?? '').replace(/\s+/g, ' '), style));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.localName;
    if (tag === 'br') out.push('\n');
    else if (tag === 'img') {
      const pic = picture(el, b);
      if (pic) aside.push(pic);
    } else if (tag === 'strong' || tag === 'b') out.push(...inlineRuns(el, { ...style, bold: true }, b, aside, keepSpace));
    else if (tag === 'em' || tag === 'i' || tag === 'cite') out.push(...inlineRuns(el, { ...style, italics: true }, b, aside, keepSpace));
    else if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') out.push(...inlineRuns(el, { ...style, code: true }, b, aside, keepSpace));
    else if (tag === 'del' || tag === 's') out.push(...inlineRuns(el, { ...style, strike: true }, b, aside, keepSpace));
    else if (tag === 'sup') out.push(...inlineRuns(el, { ...style, sup: true }, b, aside, keepSpace));
    else if (tag === 'sub') out.push(...inlineRuns(el, { ...style, sub: true }, b, aside, keepSpace));
    else if (tag === 'a') {
      const href = el.getAttribute('href') ?? '';
      out.push(...inlineRuns(el, /^https?:/i.test(href) ? { ...style, link: href } : style, b, aside, keepSpace));
    } else if (tag === 'span' && /\bplus\b/.test(el.getAttribute('class') ?? '')) out.push(...inlineRuns(el, { ...style, color: '#1a7f37' }, b, aside, keepSpace));
    else if (tag === 'span' && /\bminus\b/.test(el.getAttribute('class') ?? '')) out.push(...inlineRuns(el, { ...style, color: '#cf222e' }, b, aside, keepSpace));
    else out.push(...inlineRuns(el, style, b, aside, keepSpace));
  }
  return out;
}

const hasBlocks = (el: Element) => Array.from(el.children).some((c) => BLOCKS.has(c.localName));
const trimRuns = (runs: Content[]): Content[] => {
  const out = [...runs];
  const text = (c: Content) => (typeof c === 'string' ? c : String((c as { text?: unknown }).text ?? ''));
  while (out.length && !text(out[0]).trim()) out.shift();
  while (out.length && !text(out[out.length - 1]).trim()) out.pop();
  return out;
};

function paragraph(el: Element, b: Build, extra: Node_ = {}, style: Run = {}): Content[] {
  const aside: Content[] = [];
  const runs = trimRuns(inlineRuns(el, style, b, aside));
  return [...(runs.length ? [{ text: runs, style: 'p', ...extra }] : []), ...aside];
}

function codeBlock(pre: Element): Content {
  const diff = /\bdiff\b/.test(pre.getAttribute('class') ?? '');
  const colors: Record<string, { color?: string; background?: string }> = {
    add: { color: '#116329', background: '#e6ffec' },
    del: { color: '#a40e26', background: '#ffebe9' },
    hunk: { color: '#57606a', background: '#ddf4ff' },
  };
  const runs: Content[] = [];
  const add = (line: string, look: { color?: string; background?: string } = {}) => {
    for (const piece of wrapCode(line.replace(/\t/g, '  ').replace(EMOJI, ''))) runs.push({ text: `${piece}\n`, ...look });
  };
  if (diff && pre.children.length) {
    for (const span of Array.from(pre.children)) add((span.textContent ?? '').replace(/\n$/, ''), colors[span.getAttribute('class') ?? ''] ?? {});
  } else {
    for (const line of (pre.textContent ?? '').replace(/\n+$/, '').split('\n')) add(line);
  }
  if (!runs.length) runs.push({ text: ' ' });
  // The last line carries no line break, or the block would end in an empty line.
  const last = runs[runs.length - 1] as { text: string };
  last.text = last.text.replace(/\n$/, '');
  return {
    table: { widths: ['*'], body: [[{ text: runs, font: 'Mono', fontSize: CODE_SIZE, lineHeight: 1.18, preserveLeadingSpaces: true, color: '#1f2328' }]] },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => '#d0d7de',
      vLineColor: () => '#d0d7de',
      fillColor: () => '#f6f8fa',
      paddingLeft: () => 7,
      paddingRight: () => 7,
      paddingTop: () => 5,
      paddingBottom: () => 5,
    },
    margin: [0, 4, 0, 10],
  };
}

function table(el: Element, b: Build): Content | null {
  const rows = Array.from(el.querySelectorAll('tr')).filter((tr) => tr.closest('table') === el);
  const columns = Math.max(0, ...rows.map((tr) => tr.children.length));
  if (!rows.length || !columns) return null;
  const head = rows[0].querySelectorAll('th').length === rows[0].children.length && rows.length > 1;
  const body = rows.map((tr) => {
    const cells: Content[] = Array.from(tr.children).map((cell) => {
      const th = cell.localName === 'th';
      const inner = hasBlocks(cell) ? blocks(cell, b, TEXT_WIDTH / columns - 12) : trimRuns(inlineRuns(cell, th ? { bold: true } : {}, b, []));
      return { ...(hasBlocks(cell) ? { stack: inner } : { text: inner.length ? inner : ' ' }), ...(th ? { fillColor: '#f0f2f5' } : {}) };
    });
    while (cells.length < columns) cells.push({ text: ' ' });
    return cells;
  });
  return {
    table: { headerRows: head ? 1 : 0, widths: columns === 2 ? ['34%', '*'] : Array(columns).fill('*'), body },
    layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#c9d1d9', vLineColor: () => '#c9d1d9', paddingTop: () => 3, paddingBottom: () => 3 },
    fontSize: 8.8,
    margin: [0, 4, 0, 10],
  };
}

function listItems(el: Element, b: Build, width: number): Content[] {
  return Array.from(el.children)
    .filter((c) => c.localName === 'li')
    .map((li) => {
      if (!hasBlocks(li)) {
        const aside: Content[] = [];
        const runs = trimRuns(inlineRuns(li, {}, b, aside));
        return aside.length ? { stack: [{ text: runs }, ...aside] } : { text: runs.length ? runs : ' ' };
      }
      return { stack: blocks(li, b, width - 14) };
    });
}

/** The children of an element as the blocks of a page. */
function blocks(parent: Element, b: Build, width = TEXT_WIDTH): Content[] {
  const out: Content[] = [];
  let loose: Node[] = [];
  const flush = () => {
    if (!loose.length) return;
    const holder = parent.ownerDocument.createElement('p');
    for (const n of loose) holder.append(n.cloneNode(true));
    out.push(...paragraph(holder, b));
    loose = [];
  };
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 3) {
      if ((child.nodeValue ?? '').trim()) loose.push(child);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.localName;
    if (!BLOCKS.has(tag)) {
      loose.push(el);
      continue;
    }
    flush();
    const cls = el.getAttribute('class') ?? '';
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const aside: Content[] = [];
      const runs = trimRuns(inlineRuns(el, {}, b, aside));
      const plain = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!runs.length) continue;
      const id = `h${++b.ids}`;
      if (level === 1) {
        b.chapter = id;
        out.push({ text: runs, style: /\bbook-title\b/.test(cls) ? 'title' : /\bpath\b/.test(cls) ? 'h1path' : 'h1', id, tocItem: !/\bbook-title\b/.test(cls), outline: true, outlineText: plain });
      } else if (level === 2) out.push({ text: runs, style: 'h2', id, outline: true, outlineText: plain, ...(b.chapter ? { outlineParentId: b.chapter } : {}) });
      else out.push({ text: runs, style: level === 3 ? 'h3' : 'h4' });
      out.push(...aside);
    } else if (tag === 'p') {
      // On the title page the line above the title starts a third of the way down, with the title under it.
      if (/\bkicker\b/.test(cls)) out.push({ text: (el.textContent ?? '').trim().toUpperCase(), style: 'kicker', ...(/\bbook-title\b/.test(el.nextElementSibling?.getAttribute('class') ?? '') ? { margin: [0, 150, 0, 6] } : {}) });
      else if (/\b(note|book-meta)\b/.test(cls)) out.push(...paragraph(el, b, { style: 'note' }));
      else if (/\bbook-subtitle\b/.test(cls)) out.push(...paragraph(el, b, { style: 'subtitle' }));
      else if (/\blead\b/.test(cls)) out.push(...paragraph(el, b, { style: 'lead' }));
      else out.push(...paragraph(el, b));
    } else if (tag === 'ul' || tag === 'ol') out.push({ [tag]: listItems(el, b, width), style: 'p', margin: [4, 0, 0, 8] });
    else if (tag === 'pre') out.push(codeBlock(el));
    else if (tag === 'blockquote') {
      out.push({
        table: { widths: ['*'], body: [[{ stack: blocks(el, b, width - 16), color: '#3d444d' }]] },
        layout: { hLineWidth: () => 0, vLineWidth: (i: number) => (i === 0 ? 2.5 : 0), vLineColor: () => '#b8c0cc', paddingLeft: () => 11, paddingRight: () => 0, paddingTop: () => 2, paddingBottom: () => 0 },
        margin: [0, 4, 0, 8],
      });
    } else if (tag === 'table') {
      const t = table(el, b);
      if (t) out.push(t);
    } else if (tag === 'img') {
      const pic = picture(el, b, width);
      if (pic) out.push(pic);
    } else if (tag === 'figcaption') out.push(...paragraph(el, b, { style: 'caption' }));
    else if (tag === 'summary') out.push(...paragraph(el, b, {}, { bold: true }));
    else if (tag === 'hr') out.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.5, lineColor: '#c9d1d9' }], margin: [0, 8, 0, 12] });
    else if (tag === 'div' && /\bcover\b/.test(cls)) continue;
    else out.push(...blocks(el, b, width));
  }
  flush();
  return out;
}

/** A picture ready for a PDF, which takes only PNG and JPEG: anything else is redrawn as PNG. */
async function toPicture(data: Uint8Array, type: string, key: string): Promise<{ picture: Picture; url: string } | null> {
  const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('picture'));
      image.src = objectUrl;
    });
    const width = image.naturalWidth || 600;
    const height = image.naturalHeight || 400;
    if (type === 'image/png' || type === 'image/jpeg') return { picture: { key, width, height }, url: `data:${type};base64,${await blobToBase64(blob)}` };
    const scale = Math.min(1, 2000 / width, 2600 / height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await canvasToBlob(canvas, 'image/png');
    return { picture: { key, width, height }, url: `data:image/png;base64,${await blobToBase64(png)}` };
  } catch {
    // A picture the browser cannot show, or will not let onto a canvas, is left out.
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function epubToPdf(epub: Blob, fallbackTitle: string, onStep: (step: string) => void): Promise<Blob> {
  onStep('Готую шрифти…');
  const pdfMake = await pdfEngine();
  onStep('Читаю книжку…');
  const zip = await JSZip.loadAsync(await epub.arrayBuffer());
  const read = (path: string) => zip.file(path)?.async('string') ?? Promise.resolve('');
  const xml = (text: string, type: DOMParserSupportedType = 'application/xml') => new DOMParser().parseFromString(text, type);
  const container = xml(await read('META-INF/container.xml'));
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path') ?? '';
  const opf = xml(await read(opfPath));
  if (!opfPath || opf.querySelector('parsererror')) throw new Error('Не вдалося прочитати книжку.');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const byTag = (name: string) => Array.from(opf.getElementsByTagNameNS('*', name));
  const items = new Map(byTag('item').map((i) => [i.getAttribute('id') ?? '', { href: resolvePath(opfDir, i.getAttribute('href') ?? ''), type: i.getAttribute('media-type') ?? '', props: i.getAttribute('properties') ?? '' }]));
  const spine = byTag('itemref').map((r) => items.get(r.getAttribute('idref') ?? '')).filter((i): i is NonNullable<typeof i> => Boolean(i));
  const title = byTag('title')[0]?.textContent?.trim() || fallbackTitle;
  const author = byTag('creator')[0]?.textContent?.trim() ?? '';
  const lang = byTag('language')[0]?.textContent?.trim() || 'uk';
  const navHref = [...items.values()].find((i) => /\bnav\b/.test(i.props))?.href;
  const contentsTitle = navHref ? (xml(await read(navHref), 'application/xhtml+xml').querySelector('nav h1')?.textContent?.trim() ?? '') : '';

  onStep('Готую картинки…');
  const pictures = new Map<string, Picture>();
  const urls: Record<string, string> = {};
  let n = 0;
  for (const item of items.values()) {
    if (!item.type.startsWith('image/')) continue;
    const bytes = await zip.file(item.href)?.async('uint8array');
    if (!bytes) continue;
    const key = `p${++n}`;
    const made = await toPicture(bytes, item.type, key);
    if (!made) continue;
    pictures.set(item.href, made.picture);
    urls[key] = made.url;
  }
  const cover = [...items.values()].find((i) => /\bcover-image\b/.test(i.props));
  const coverPicture = cover ? pictures.get(cover.href) : undefined;

  onStep('Верстаю сторінки…');
  const b: Build = { pictures, dir: '', chapter: '', ids: 0 };
  const content: Content[] = [];
  if (coverPicture) {
    // The cover fills the first page from edge to edge.
    content.push({ image: coverPicture.key, cover: { width: PAGE.width, height: PAGE.height, valign: 'center', align: 'center' }, absolutePosition: { x: 0, y: 0 } }, { text: '', pageBreak: 'after' });
  }
  let first = true;
  let tocPlaced = false;
  for (const item of spine) {
    if (item.href === navHref) continue;
    const doc = xml(await read(item.href), 'application/xhtml+xml');
    const bodyEl = doc.querySelector('body');
    if (!bodyEl || doc.querySelector('parsererror')) continue;
    b.dir = item.href.includes('/') ? item.href.slice(0, item.href.lastIndexOf('/')) : '';
    const page = blocks(bodyEl, b);
    if (!page.length) continue;
    // Every page of the book starts a page of paper.
    if (!first && typeof page[0] === 'object') (page[0] as Node_).pageBreak = 'before';
    content.push(...page);
    // The contents follow the title page.
    if (first && spine.length > 2) {
      content.push({ toc: { title: { text: contentsTitle || 'Зміст', style: 'h1' }, numberStyle: { fontSize: 10 } }, pageBreak: 'before' });
      tocPlaced = true;
    }
    first = false;
  }
  if (!content.length) throw new Error('У цій книжці немає тексту, з якого можна зробити PDF.');
  void tocPlaced;

  onStep('Записую PDF…');
  const doc: Node_ = {
    pageSize: 'A4',
    pageMargins: [MARGIN.x, MARGIN.y, MARGIN.x, MARGIN.y],
    info: { title, author, creator: 'Закладка' },
    language: lang,
    images: urls,
    content,
    footer: (page: number) => (page > 1 || !coverPicture ? { text: String(page), alignment: 'center', fontSize: 8.5, color: '#6e7781', margin: [0, 24, 0, 0] } : ''),
    defaultStyle: { font: 'Serif', fontSize: 10.5, lineHeight: 1.32, color: '#1f2328' },
    styles: {
      title: { fontSize: 27, bold: true, lineHeight: 1.12, margin: [0, 0, 0, 10] },
      subtitle: { fontSize: 14, lineHeight: 1.3, margin: [0, 0, 0, 22], color: '#3d444d' },
      h1: { fontSize: 20, bold: true, lineHeight: 1.15, margin: [0, 0, 0, 14] },
      h1path: { font: 'Mono', fontSize: 12.5, bold: true, margin: [0, 0, 0, 10] },
      h2: { fontSize: 14.5, bold: true, lineHeight: 1.2, margin: [0, 14, 0, 6] },
      h3: { fontSize: 12, bold: true, margin: [0, 10, 0, 4] },
      h4: { fontSize: 10.5, bold: true, margin: [0, 8, 0, 3] },
      p: { margin: [0, 0, 0, 7] },
      lead: { fontSize: 12, bold: true, lineHeight: 1.3, margin: [0, 0, 0, 10] },
      note: { fontSize: 8.8, color: '#57606a', margin: [0, 0, 0, 7] },
      caption: { fontSize: 8.8, italics: true, color: '#57606a', alignment: 'center', margin: [0, 0, 0, 10] },
      kicker: { fontSize: 8, color: '#6e7781', characterSpacing: 1.2, margin: [0, 0, 0, 4] },
    },
  };
  return pdfMake.createPdf(doc).getBlob();
}
