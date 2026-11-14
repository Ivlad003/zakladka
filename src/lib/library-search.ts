// Search across every book in the library, whatever its format: by exact words and by meaning.
// Both work on plain text that is read out of each book once and then kept in IndexedDB.
import { db } from '../db';
import { openEngine } from '../engines';
import { OcrLayeredEngine } from '../engines/ocr-engine';
import type { Engine } from '../engines/types';
import type { BookRecord, BookText, SearchHit } from '../types';
import { buildIndex, chunkText, scoreIndex, type BuildProgress, type Embedder } from './semantic';
import { makeExcerpt, queryRegex } from './utils';

/** Text of the book, or why there is none on this device. */
export type TextResult = BookText | 'no-file';

class Aborted extends Error {}
const check = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Aborted();
};
export const isAborted = (err: unknown): boolean => err instanceof Aborted || (err instanceof DOMException && err.name === 'AbortError');

/**
 * Returns the text of a book, reading it out of the file the first time. Scanned pages contribute
 * their OCR text; when more pages have been recognised since, the text is read again.
 */
export async function ensureBookText(book: BookRecord, signal?: AbortSignal): Promise<TextResult> {
  const ocrPages = book.format === 'epub' ? 0 : await db.ocr.where('bookId').equals(book.id).count();
  const cached = await db.texts.get(book.id);
  if (cached && cached.ocrPages === ocrPages) return cached;
  const file = await db.files.get(book.id);
  // Known from sync but not downloaded: whatever was read earlier still serves.
  if (!file) return cached ?? 'no-file';
  check(signal);

  let engine: Engine = await openEngine(book.format, await file.data.arrayBuffer());
  try {
    if (engine.kind === 'fixed' && ocrPages) {
      const layered = new OcrLayeredEngine(engine);
      layered.load(await db.ocr.where('bookId').equals(book.id).toArray());
      engine = layered;
    }
    const units: string[] = [];
    const labels: (string | null)[] = [];
    for (let unit = 0; unit < engine.unitCount; unit++) {
      check(signal);
      // Kept exactly as the reader sees it, so the n-th match here is the n-th match there.
      units.push(await engine.getUnitText(unit).catch(() => ''));
      labels.push(engine.kind === 'epub' ? (engine.titleForUnit(unit) ?? null) : null);
    }
    const text: BookText = { bookId: book.id, units, labels, ocrPages, builtAt: Date.now() };
    await db.texts.put(text);
    return text;
  } finally {
    engine.destroy();
  }
}

export const unitLabel = (book: BookRecord, text: Pick<BookText, 'labels'> | null, unit: number): string =>
  book.format === 'epub' ? (text?.labels[unit] ?? `Розділ ${unit + 1}`) : `стор. ${unit + 1}`;

export interface BookHits {
  book: BookRecord;
  /** The first matches, in reading order. */
  hits: SearchHit[];
  /** How many matches the book has in all. */
  total: number;
}

/** Every occurrence of the query in one book's text; keeps the first `keep` and counts the rest. */
export function searchBookText(book: BookRecord, text: BookText, query: string, keep = 200): BookHits {
  const re = queryRegex(query);
  const hits: SearchHit[] = [];
  let total = 0;
  if (!re) return { book, hits, total };
  for (let unit = 0; unit < text.units.length; unit++) {
    const body = text.units[unit];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let matchIndex = 0;
    while ((m = re.exec(body))) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (hits.length < keep) hits.push({ unit, label: unitLabel(book, text, unit), matchIndex, ...makeExcerpt(body, m.index, m[0].length, 70) });
      matchIndex++;
      total++;
    }
  }
  return { book, hits, total };
}

// ---- Search by meaning ----

export interface MeaningHit {
  book: BookRecord;
  unit: number;
  label: string;
  text: string;
  score: number;
}

/** Which books have an index that the current embedding model can search. */
export async function indexedBooks(embedderId: string): Promise<Set<string>> {
  const ready = new Set<string>();
  // One row at a time: an index holds megabytes of vectors, and only its model name is needed here.
  await db.vectors.each((index) => {
    if (index.model === embedderId) ready.add(index.bookId);
  });
  return ready;
}

/** The passages closest in meaning to the query, across every indexed book. */
export async function searchByMeaning(books: BookRecord[], embedder: Embedder, query: string, limit: number, signal?: AbortSignal): Promise<MeaningHit[]> {
  const [q] = await embedder.embed([query], 'query', signal);
  const byId = new Map(books.map((b) => [b.id, b]));
  const labels = new Map<string, BookText['labels']>();
  await db.texts.each((t) => void labels.set(t.bookId, t.labels));
  const all: MeaningHit[] = [];
  await db.vectors.each((index) => {
    const book = byId.get(index.bookId);
    if (!book || index.model !== embedder.id || index.dims !== q.length) return;
    const text = { labels: labels.get(book.id) ?? [] };
    for (const hit of scoreIndex(index, q, limit)) all.push({ book, ...hit, label: unitLabel(book, text, hit.unit) });
  });
  check(signal);
  return all.sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface IndexAllProgress {
  /** 1-based position of the book being worked on. */
  book: number;
  books: number;
  title: string;
  step: BuildProgress | null;
}

/** Builds the semantic index of every given book, one after another. Returns the books that had no text. */
export async function indexBooks(
  books: BookRecord[],
  embedder: Embedder,
  signal: AbortSignal,
  onProgress: (p: IndexAllProgress) => void,
): Promise<{ skipped: BookRecord[] }> {
  const skipped: BookRecord[] = [];
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    const report = (step: BuildProgress | null) => onProgress({ book: i + 1, books: books.length, title: book.title, step });
    check(signal);
    report({ done: 0, total: 0, status: 'Читаю книгу…' });
    const text = await ensureBookText(book, signal);
    // A scan that has not been through OCR, or a file that is not on this device, has nothing to index.
    if (text === 'no-file' || !text.units.some((u) => chunkText(u).length)) {
      skipped.push(book);
      continue;
    }
    await buildIndex({
      engine: { unitCount: text.units.length, getUnitText: async (unit) => text.units[unit] },
      bookId: book.id,
      embedder,
      signal,
      onProgress: report,
    });
  }
  check(signal);
  return { skipped };
}
