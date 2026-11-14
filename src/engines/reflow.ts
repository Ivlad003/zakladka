// The text mode for PDF and DjVu: the text of the pages laid out again like an EPUB, so that it
// follows the reader's font, size, line spacing and theme and fits a phone screen.
//
// Each page of the original becomes one section of an EPUB built in memory. Page N of the book is
// section N, so everything that counts in pages — the reading position, search results, notes, the
// semantic index, what the agents read — means the same in both modes.
//
// From a PDF the lines come with their position and size, which is enough to tell paragraphs
// (a gap above, an indented first line, a short last line), headings (bigger type) and running
// heads and page numbers (the same short line at the top or bottom of many pages, dropped).
// DjVu and pages recognised by OCR give plain lines, and paragraphs are told from line lengths.
// A page without text is shown as a picture of the page; a book that is mostly such pages has to
// go through OCR first.
import { db } from '../db';
import { guessLang } from '../lib/read-aloud';
import type { TocItem } from '../types';
import { buildEpub, escapeXml, type EpubToc } from './epub-build';
import type { FixedEngine, PageLayout, PageLine } from './types';

/** Bumped whenever the way text is laid out changes, so that stored copies are made again. */
export const REFLOW_VERSION = 2;

export class ReflowError extends Error {}

export interface ReflowProgress {
  done: number;
  total: number;
}

type Block = { kind: 'p' | 'h1' | 'h2' | 'h3'; text: string };

const SENTENCE_END = /[.!?…:;»"”)\]]$/;
const WORD_START = /^\p{Ll}/u;

/** Joins two pieces of a paragraph, mending a word split across lines with a hyphen. */
function join(text: string, next: string): string {
  if (!text) return next;
  if (/[\p{L}][-­]$/u.test(text) && WORD_START.test(next)) return text.slice(0, -1) + next;
  return `${text} ${next}`;
}

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Running heads and page numbers: short lines that repeat at the same edge of many pages. */
const normalizeEdge = (text: string) => text.toLocaleLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const isPageNumber = (text: string) => /^([-–—\s]*\d{1,4}[-–—\s]*|(стор|с|page|p)\.?\s*\d{1,4}|[ivxlcdm]{1,6})$/i.test(text.trim());

function edgeLines(layout: PageLayout): PageLine[] {
  const band = layout.height * 0.08;
  return layout.lines.filter((l) => l.text.length < 120 && (l.y < band + l.size || l.y > layout.height - band));
}

/** Paragraphs and headings of a page whose lines carry positions. */
function blocksFromLayout(layout: PageLayout, bodySize: number, skip: Set<PageLine>): Block[] {
  const lines = layout.lines.filter((l) => !skip.has(l) && l.text.trim());
  if (!lines.length) return [];
  const body = lines.filter((l) => Math.abs(l.size - bodySize) < bodySize * 0.15);
  const left = median(body.map((l) => l.x)) || Math.min(...lines.map((l) => l.x));
  const right = Math.max(...(body.length ? body : lines).map((l) => l.xEnd));
  const gaps: number[] = [];
  for (let i = 1; i < body.length; i++) {
    const gap = body[i].y - body[i - 1].y;
    if (gap > 0 && gap < bodySize * 3) gaps.push(gap);
  }
  const lineGap = median(gaps) || bodySize * 1.25;

  const blocks: Block[] = [];
  let current: Block | null = null;
  let previous: PageLine | null = null;
  const levelOf = (l: PageLine): Block['kind'] => {
    if (l.text.length > 160 || l.size < bodySize * 1.18) return 'p';
    return l.size >= bodySize * 1.7 ? 'h1' : l.size >= bodySize * 1.35 ? 'h2' : 'h3';
  };
  for (const line of lines) {
    const kind = levelOf(line);
    let fresh = !current || !previous || current.kind !== kind;
    if (!fresh && previous && current) {
      const gap = line.y - previous.y;
      const column = gap < -bodySize || gap > layout.height * 0.5; // the next column, or the page again from the top
      const spaced = gap > lineGap * 1.55 && !column;
      const indented = kind === 'p' && line.x > left + bodySize * 0.9 && line.x - previous.x > bodySize * 0.9;
      const shortBefore = previous.xEnd < right - bodySize * 3 && SENTENCE_END.test(previous.text);
      const sizeJump = Math.abs(line.size - previous.size) > bodySize * 0.2;
      fresh = spaced || indented || sizeJump || (shortBefore && !column);
    }
    if (fresh) {
      current = { kind, text: line.text };
      blocks.push(current);
    } else if (current) {
      current.text = join(current.text, line.text);
    }
    previous = line;
  }
  return blocks;
}

/** Paragraphs of a page that only has plain lines (DjVu, OCR). */
function blocksFromText(text: string): Block[] {
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const lengths = lines.filter(Boolean).map((l) => l.length);
  const full = lengths.length ? [...lengths].sort((a, b) => a - b)[Math.floor(lengths.length * 0.8)] : 0;
  const blocks: Block[] = [];
  let current: Block | null = null;
  let previous = '';
  for (const line of lines) {
    if (!line) {
      current = null;
      previous = '';
      continue;
    }
    // Lines this short are a heading or a page number when they stand alone.
    if (!current || (previous.length < full * 0.72 && SENTENCE_END.test(previous))) {
      current = { kind: 'p', text: line };
      blocks.push(current);
    } else {
      current.text = join(current.text, line);
    }
    previous = line;
  }
  return blocks.filter((b, i) => !(i === 0 && isPageNumber(b.text)) && !(i === blocks.length - 1 && isPageNumber(b.text)));
}

const pageFile = (unit: number) => `p${String(unit + 1).padStart(5, '0')}.xhtml`;

const STYLE = `body { line-height: 1.5; }
p { margin: 0; text-indent: 1.3em; text-align: start; hyphens: auto; -webkit-hyphens: auto; }
h1, h2, h3 { text-indent: 0; line-height: 1.25; margin: 1.1em 0 0.6em; }
h1 { font-size: 1.5em; } h2 { font-size: 1.25em; } h3 { font-size: 1.08em; }
h1 + p, h2 + p, h3 + p { text-indent: 0; }
.pg { margin: 0 0 0.6em; }
.page-image { text-align: center; margin: 0.5em 0; }
.page-image img { max-width: 100%; height: auto; }
`;

export interface ReflowSource {
  engine: FixedEngine;
  title: string;
  author: string;
}

/** Builds the text-mode EPUB of a PDF or DjVu book. */
export async function buildReflow(source: ReflowSource, onProgress: (p: ReflowProgress) => void, signal: AbortSignal): Promise<Blob> {
  const { engine } = source;
  const total = engine.unitCount;
  const pages: ({ kind: 'layout'; layout: PageLayout } | { kind: 'text'; text: string })[] = [];
  for (let i = 0; i < total; i++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const layout = await engine.getUnitLayout?.(i).catch(() => null);
    pages.push(layout?.lines.length ? { kind: 'layout', layout } : { kind: 'text', text: await engine.getUnitText(i).catch(() => '') });
    if (i % 5 === 0 || i === total - 1) {
      onProgress({ done: i + 1, total });
      // Let the screen update between batches.
      await new Promise((done) => setTimeout(done, 0));
    }
  }

  // The body text size of the book: the size most of its characters are set in.
  const weighted = new Map<number, number>();
  for (const page of pages) {
    if (page.kind !== 'layout') continue;
    for (const l of page.layout.lines) weighted.set(Math.round(l.size * 2) / 2, (weighted.get(Math.round(l.size * 2) / 2) ?? 0) + l.text.length);
  }
  const bodySize = [...weighted].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;

  // Running heads: an edge line that recurs on a good share of the pages.
  const counts = new Map<string, number>();
  for (const page of pages) {
    if (page.kind !== 'layout') continue;
    for (const key of new Set(edgeLines(page.layout).map((l) => normalizeEdge(l.text)))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const textPages = pages.filter((p) => p.kind === 'layout').length;
  const repeated = (key: string) => textPages >= 4 && (counts.get(key) ?? 0) >= Math.max(3, textPages * 0.3);

  const files: { name: string; title: string; body: string }[] = [];
  const images: { file: string; type: string; data: Uint8Array }[] = [];
  const headings: EpubToc[] = [];
  let textless = 0;
  let sample = '';
  const blocksOf: Block[][] = pages.map((page) => {
    if (page.kind === 'text') return blocksFromText(page.text);
    const skip = new Set(edgeLines(page.layout).filter((l) => isPageNumber(l.text) || repeated(normalizeEdge(l.text))));
    return blocksFromLayout(page.layout, bodySize, skip);
  });
  // A page with (next to) no text is shown as a picture; a book of mostly such pages is a scan.
  const withoutText = blocksOf.map((blocks) => blocks.reduce((n, b) => n + b.text.length, 0) < 25);
  textless = withoutText.filter(Boolean).length;
  if (total > 2 && textless > total * 0.6) {
    throw new ReflowError(
      `У ${textless} із ${total} сторінок немає тексту — це скан. Щоб читати його в текстовому режимі, спершу розпізнайте текст (кнопка OCR у режимі «Оригінал»).`,
    );
  }
  // A paragraph that runs over a page break is put back together on the page where it starts.
  for (let i = 0; i + 1 < total; i++) {
    const last = blocksOf[i].at(-1);
    const next = blocksOf[i + 1][0];
    if (!last || !next || last.kind !== 'p' || next.kind !== 'p' || SENTENCE_END.test(last.text)) continue;
    if (!WORD_START.test(next.text) && !/[-­,]$/.test(last.text)) continue;
    // A page that would be left empty keeps its text, so that no blank screen stands in for it.
    if (blocksOf[i + 1].length < 2) continue;
    last.text = join(last.text, next.text);
    blocksOf[i + 1].shift();
  }

  for (let i = 0; i < total; i++) {
    const blocks = blocksOf[i];
    if (sample.length < 3000) sample += blocks.map((b) => b.text).join(' ');
    let body = blocks.map((b) => `<${b.kind}>${escapeXml(b.text)}</${b.kind}>`).join('\n');
    if (withoutText[i]) {
      // No text to lay out: the page itself, as a picture.
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const blob = await engine.renderImage(i, 1000).catch(() => null);
      if (blob) {
        const file = `images/p${String(i + 1).padStart(5, '0')}.jpg`;
        images.push({ file, type: 'image/jpeg', data: new Uint8Array(await blob.arrayBuffer()) });
        body = `<div class="page-image"><img src="${file}" alt="Сторінка ${i + 1}"/></div>${body}`;
      }
    }
    for (const b of blocks) if (b.kind !== 'p' && headings.length < 400) headings.push({ title: b.text.slice(0, 120), href: pageFile(i), depth: b.kind === 'h3' ? 2 : 1 });
    files.push({ name: pageFile(i), title: `Сторінка ${i + 1}`, body: `<div class="pg" data-page="${i + 1}">\n${body}\n</div>` });
  }

  // The first page as the cover, so that a copy saved to the library looks like the book.
  const cover = await engine.makeCover().catch(() => null);
  if (cover) images.push({ file: 'images/cover.jpg', type: cover.type || 'image/jpeg', data: new Uint8Array(await cover.arrayBuffer()) });

  // Contents: the book's own outline when it has one, else the headings found.
  const outline = await engine.getToc().catch(() => [] as TocItem[]);
  const toc: EpubToc[] = [];
  const walk = (items: TocItem[], depth: number) => {
    for (const item of items) {
      if (item.unit !== undefined && item.unit >= 0 && item.unit < total) toc.push({ title: item.title, href: pageFile(item.unit), depth });
      walk(item.children, depth + 1);
    }
  };
  walk(outline, 1);

  return buildEpub({
    id: `urn:reflow:${total}`,
    title: source.title,
    authors: source.author ? [source.author] : [],
    lang: guessLang(sample),
    css: STYLE,
    files,
    images,
    cover: cover ? 'images/cover.jpg' : undefined,
    toc: toc.length ? toc : headings,
  });
}

/** The text-mode EPUB of a book, made once and kept; made again when the book's OCR text has changed. */
export async function ensureReflow(
  bookId: string,
  source: ReflowSource,
  ocrPages: number,
  onProgress: (p: ReflowProgress) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const kept = await db.reflows.get(bookId);
  if (kept && kept.version === REFLOW_VERSION && kept.ocrPages === ocrPages) return kept.epub;
  const epub = await buildReflow(source, onProgress, signal);
  await db.reflows.put({ bookId, version: REFLOW_VERSION, ocrPages, epub, builtAt: Date.now() });
  return epub;
}
