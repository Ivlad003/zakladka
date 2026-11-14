// A table of contents for PDF and DjVu books that have none of their own, made from their text.
//
// Two ways, the better one first:
//  1. The book's printed contents page: lines that end in a page number ("Глава 2 ........ 45")
//     near the start or the end of the book. The printed numbers are turned into pages of the file
//     by the page numbers printed on the pages themselves, or, failing that, by finding the titles
//     in the text.
//  2. The headings: lines set in bigger type than the body text, and lines that read like a
//     heading ("Розділ 3", "Chapter IV", "Вступ") where the size of the type is not known.
// Scanned pages take part once their text has been recognised (OCR).
import { db } from '../db';
import { bodySizeOf, edgeLines, isPageNumber, runningHeads } from '../engines/page-text';
import type { FixedEngine, PageLayout, PageLine } from '../engines/types';
import type { TocItem } from '../types';

/** Bumped whenever the way contents are found changes, so that stored ones are made again. */
export const AUTO_TOC_VERSION = 1;

export type AutoTocSource = 'contents' | 'headings';

export interface AutoToc {
  items: TocItem[];
  source: AutoTocSource;
}

export interface AutoTocProgress {
  done: number;
  total: number;
}

interface Page {
  /** Lines with position and size (PDF, DjVu text layer, OCR words), or null for plain text. */
  layout: PageLayout | null;
  lines: { text: string; x: number; size: number }[];
}

interface Entry {
  title: string;
  unit: number;
  level: number;
}

const bare = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const CONTENTS_TITLE = /^(зміст|содержание|оглавление|contents|table of contents|spis treści|inhalt|inhaltsverzeichnis|sommaire|table des matières)\.?$/i;
/** "Title ....... 45", "Title  45", "Title · 45". */
const ENTRY = /^(.*?[\p{L}].*?)(?:\s*(?:[.·•…_]\s*){2,}|\s+[-–—]?\s*)(\d{1,4})$/u;
/** "Глава 1" on a line of its own reads like an entry for page 1; it is the start of a title. */
const LABEL_ONLY = /^(розділ|глава|частина|книга|часть|раздел|chapter|part|book|section|lecture|rozdział|część|kapitel|teil|chapitre|partie)\.?$/i;
const HEADING_WORD =
  /^(розділ|глава|частина|книга|лекція|урок|тема|додаток|часть|раздел|лекция|приложение|chapter|part|book|section|lecture|lesson|appendix|rozdział|część|kapitel|teil|chapitre|partie)\b[\s.:№]*([0-9]+|[ivxlcdm]+\b|[\p{L}]+)/iu;
const PART_WORD = /^(частина|книга|часть|part|book|część|teil|partie)\b/i;
const STANDALONE = /^(вступ|передмова|післямова|висновки|список літератури|література|покажчик|введение|предисловие|послесловие|заключение|список литературы|литература|указатель|introduction|preface|foreword|afterword|conclusion|epilogue|prologue|bibliography|references|index|пролог|епілог|эпилог|wstęp|zakończenie|einleitung|vorwort|avant-propos)\.?$/i;
const NUMBERED = /^(\d{1,2}(\.\d{1,2}){0,3})\.?\s+(\p{Lu}.*)$/u;

const mode = (values: number[]): { value: number; count: number } | null => {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best ? { value: best[0], count: best[1] } : null;
};

/** Entries in reading order → the nested shape of a table of contents. */
function nest(entries: Entry[]): TocItem[] {
  const root: TocItem[] = [];
  const stack: { level: number; item: TocItem }[] = [];
  for (const e of entries) {
    const item: TocItem = { title: e.title, unit: e.unit, children: [] };
    while (stack.length && stack[stack.length - 1].level >= e.level) stack.pop();
    (stack.length ? stack[stack.length - 1].item.children : root).push(item);
    stack.push({ level: e.level, item });
  }
  return root;
}

/** How the printed page numbers relate to the pages of the file: page index = printed number + offset. */
function printedOffset(pages: Page[]): number | null {
  const offsets: number[] = [];
  pages.forEach((page, i) => {
    const edges = page.layout ? edgeLines(page.layout).map((l) => l.text) : [page.lines[0]?.text ?? '', page.lines.at(-1)?.text ?? ''];
    for (const text of edges) {
      const t = text.trim();
      // A bare number, or a running head that starts or ends with one ("34   Глава 1. …").
      const m = /^(\d{1,4})$/.exec(t) ?? /^(\d{1,4})\s{1,}\S/.exec(t) ?? /\S\s{1,}(\d{1,4})$/.exec(t);
      if (m && Number(m[1]) > 0) offsets.push(i - Number(m[1]));
    }
  });
  const best = mode(offsets);
  return best && best.count >= 3 && best.count >= offsets.length * 0.3 ? best.value : null;
}

/** The printed contents of the book, if it has them where contents usually are. */
function fromContentsPage(pages: Page[]): Entry[] | null {
  const total = pages.length;
  const candidates = [...Array.from({ length: Math.min(30, total) }, (_, i) => i), ...Array.from({ length: Math.min(25, total) }, (_, i) => total - 1 - i)];
  const parse = (page: Page) => {
    const entries: { title: string; printed: number; x: number; size: number }[] = [];
    let pending = '';
    let pendingX = 0;
    for (const line of page.lines) {
      const text = line.text.replace(/\s+/g, ' ').trim();
      if (!text || CONTENTS_TITLE.test(text)) continue;
      const m = ENTRY.exec(text);
      if (m && !isPageNumber(text) && !LABEL_ONLY.test(m[1].trim())) {
        const title = `${pending ? `${pending} ` : ''}${m[1]}`.replace(/[\s.·•…_]+$/u, '').trim();
        if (title.length >= 2) entries.push({ title, printed: Number(m[2]), x: pending ? pendingX : line.x, size: line.size });
        pending = '';
      } else if (text.length < 90 && /\p{L}/u.test(text) && !pending) {
        // A long title that wraps: its first line has no number yet.
        pending = text;
        pendingX = line.x;
      } else {
        pending = '';
      }
    }
    const share = page.lines.length ? entries.length / page.lines.length : 0;
    const titled = page.lines.some((l) => CONTENTS_TITLE.test(l.text.trim()));
    return { entries, ok: (entries.length >= 5 && share >= 0.4) || (titled && entries.length >= 3) };
  };

  for (const start of candidates) {
    const first = parse(pages[start]);
    if (!first.ok) continue;
    // The contents may run over several pages.
    const found = [...first.entries];
    let last = start;
    for (let i = start + 1; i < total && i < start + 12; i++) {
      const next = parse(pages[i]);
      if (!(next.entries.length >= 3 && next.ok)) break;
      found.push(...next.entries);
      last = i;
    }
    // Page numbers of contents go up; a list where they mostly do not is something else (an index, a table).
    let rising = 0;
    for (let i = 1; i < found.length; i++) if (found[i].printed >= found[i - 1].printed) rising++;
    if (found.length < 4 || rising < (found.length - 1) * 0.8) continue;

    let offset = printedOffset(pages);
    if (offset === null) {
      // No page numbers on the pages: find some of the titles in the text and see how far they are.
      const after = (from: number) => pages.slice(from).map((p, k) => ({ index: from + k, starts: p.lines.map((l) => bare(l.text)) }));
      const text = start < total / 2 ? after(last + 1) : after(0);
      const guesses: number[] = [];
      for (const entry of found.slice(0, 40)) {
        const key = bare(entry.title).slice(0, 28);
        if (key.length < 6) continue;
        const hit = text.find((p) => p.starts.some((s) => s.startsWith(key)));
        if (hit) guesses.push(hit.index - entry.printed);
      }
      const best = mode(guesses);
      offset = best && best.count >= 2 ? best.value : 0;
    }

    const minX = Math.min(...found.map((e) => e.x));
    const size = found[0]?.size || 10;
    const entries: Entry[] = [];
    for (const e of found) {
      const unit = e.printed + offset;
      if (unit < 0 || unit >= total) continue;
      const numbered = /^(\d{1,2}(\.\d{1,2}){0,3})\.?\s/.exec(e.title);
      const byNumber = numbered ? numbered[1].split('.').filter(Boolean).length : 0;
      const byIndent = size > 0 ? 1 + Math.round((e.x - minX) / (size * 1.5)) : 1;
      entries.push({ title: e.title, unit, level: Math.min(3, Math.max(1, byNumber || byIndent)) });
    }
    return entries.length >= 4 ? entries : null;
  }
  return null;
}

/** Headings found in the text: bigger type, or words that announce a heading. */
function fromHeadings(pages: Page[]): Entry[] {
  const layouts = pages.flatMap((p) => (p.layout ? [p.layout] : []));
  const body = bodySizeOf(layouts);
  const isRunningHead = runningHeads(layouts);

  type Candidate = { title: string; unit: number; size: number; rank: 'size' | 'word' | 'part' };
  const found: Candidate[] = [];
  pages.forEach((page, unit) => {
    if (page.layout) {
      const layout = page.layout;
      let open: (Candidate & { y: number }) | null = null;
      const right = Math.max(...layout.lines.map((l) => l.xEnd));
      for (const line of layout.lines) {
        const text = line.text.replace(/\s+/g, ' ').trim();
        const usable = text.length >= 2 && text.length <= 120 && /\p{L}/u.test(text) && !isRunningHead(line, layout) && !isPageNumber(text);
        const big = usable && line.size >= body * 1.18;
        // Same-size headings are told by their words, and only on a short line of their own, not inside a paragraph.
        const ownLine = line.xEnd < right - body * 4 && text.length < 80 && !/[-,;]$/.test(text);
        const numberedDeep = /^\d{1,2}\.\d{1,2}(\.\d{1,2})*\.?\s+\p{Lu}/u.test(text) && !/[.:;,]$/.test(text);
        const word = usable && ownLine && (HEADING_WORD.test(text) || STANDALONE.test(text) || numberedDeep);
        if (big || word) {
          // A heading set over two lines is one heading.
          if (open && Math.abs(open.size - line.size) < line.size * 0.06 && line.y - open.y < line.size * 2.4) {
            open.title += ` ${text}`;
            open.y = line.y;
            continue;
          }
          open = { title: text, unit, size: big ? line.size : 0, rank: PART_WORD.test(text) ? 'part' : big ? 'size' : 'word', y: line.y };
          found.push(open);
        } else {
          open = null;
        }
      }
    } else {
      for (const line of page.lines) {
        const text = line.text.replace(/\s+/g, ' ').trim();
        if (text.length > 90 || isPageNumber(text)) continue;
        if (HEADING_WORD.test(text) || STANDALONE.test(text)) found.push({ title: text, unit, size: 0, rank: PART_WORD.test(text) ? 'part' : 'word' });
        else if (NUMBERED.test(text) && !/[.,;:]$/.test(text) && text.length < 70) found.push({ title: text, unit, size: 0, rank: 'word' });
      }
    }
  });

  // A size used on a great many pages is a design element (a running title, a drop cap), not a heading.
  const pagesWithSize = new Map<number, Set<number>>();
  for (const c of found) {
    if (!c.size) continue;
    const key = Math.round(c.size);
    if (!pagesWithSize.has(key)) pagesWithSize.set(key, new Set());
    pagesWithSize.get(key)!.add(c.unit);
  }
  const tooCommon = (size: number) => pages.length >= 10 && (pagesWithSize.get(Math.round(size))?.size ?? 0) > pages.length * 0.5;
  const kept = found.filter((c) => !(c.size && tooCommon(c.size)));

  // Levels: parts on top, then heading sizes from the biggest down; headings known only by their words sit under the sizes.
  const sizes = [...new Set(kept.filter((c) => c.size).map((c) => Math.round(c.size * 2) / 2))].sort((a, b) => b - a).slice(0, 3);
  const hasParts = kept.some((c) => c.rank === 'part');
  const entries: Entry[] = [];
  for (const c of kept) {
    let level: number;
    if (c.rank === 'part') level = 1;
    else if (c.size) {
      const at = sizes.indexOf(Math.round(c.size * 2) / 2);
      if (at < 0) continue; // a fourth size and smaller: too fine for a table of contents
      level = at + 1 + (hasParts ? 1 : 0);
    } else level = (hasParts ? 2 : 1) + (sizes.length ? 1 : 0);
    const last = entries.at(-1);
    // The same heading again on the next page (a repeated chapter title) is one entry.
    if (last && bare(last.title) === bare(c.title) && c.unit - last.unit <= 1) continue;
    entries.push({ title: c.title.slice(0, 140), unit: c.unit, level: Math.min(4, level) });
  }
  // A page full of "headings" is a list or a table; better no contents than that.
  const perPage = mode(entries.map((e) => e.unit));
  if (perPage && perPage.count > 8) return entries.filter((e) => e.unit !== perPage.value).slice(0, 600);
  return entries.slice(0, 600);
}

/** Makes a table of contents from the book's text. Empty when nothing reliable was found. */
export async function buildAutoToc(engine: FixedEngine, onProgress: (p: AutoTocProgress) => void, signal: AbortSignal): Promise<AutoToc> {
  const pages: Page[] = [];
  const total = engine.unitCount;
  for (let i = 0; i < total; i++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const layout = (await engine.getUnitLayout?.(i).catch(() => null)) ?? null;
    if (layout?.lines.length) {
      pages.push({ layout, lines: [...layout.lines].map((l: PageLine) => ({ text: l.text, x: l.x, size: l.size })) });
    } else {
      const text = await engine.getUnitText(i).catch(() => '');
      pages.push({ layout: null, lines: text.split('\n').map((t) => ({ text: t.trim(), x: 0, size: 0 })).filter((l) => l.text) });
    }
    if (i % 4 === 3 || i === total - 1) {
      onProgress({ done: i + 1, total });
      // In the background of an open book: leave room for drawing the pages.
      await new Promise((done) => setTimeout(done, 0));
    }
  }
  const printed = fromContentsPage(pages);
  if (printed) return { items: nest(printed), source: 'contents' };
  const headings = fromHeadings(pages);
  return { items: headings.length >= 2 ? nest(headings) : [], source: 'headings' };
}

/** A stored table of contents for the book, when it is still current. */
export async function storedAutoToc(bookId: string, ocrPages: number): Promise<AutoToc | null> {
  const kept = await db.tocs.get(bookId);
  return kept && kept.version === AUTO_TOC_VERSION && kept.ocrPages === ocrPages ? { items: kept.items, source: kept.source } : null;
}

export async function saveAutoToc(bookId: string, toc: AutoToc, ocrPages: number): Promise<void> {
  await db.tocs.put({ bookId, version: AUTO_TOC_VERSION, ocrPages, items: toc.items, source: toc.source, builtAt: Date.now() });
  // The text mode's copy carries the contents in its own table of contents: it is made again with them.
  await db.reflows.delete(bookId);
}
