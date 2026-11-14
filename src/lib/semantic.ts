// Semantic ("by meaning") search: a small vector index per book, kept in IndexedDB and scanned by brute force.
// A book is a few thousand passages at most, so an exact scan takes milliseconds and needs no index structure.
import { authHeaders, isBlockedMixedContent, MIXED_CONTENT_HINT, ProviderError, readErrorMessage, trimUrl } from '../ai/providers';
import { db } from '../db';
import { duringWork } from './busy';
import type { Engine } from '../engines/types';
import type { Settings } from '../settings';
import type { VectorIndex } from '../types';
import type { EmbedRequest, EmbedResponse } from './embed.worker';

export interface Embedder {
  /** Stored with the index; a different id means the index must be rebuilt. */
  id: string;
  label: string;
  /** Texts per request. */
  batch: number;
  /** Returns one unit-length vector per text. */
  embed(texts: string[], kind: 'query' | 'passage', signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface BuildProgress {
  done: number;
  total: number;
  status: string;
}

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;
const MIN_CHUNK = 24;
/** Multilingual (incl. Ukrainian), 384 dimensions; the 8-bit quantised weights are about 120 MB. */
export const DEFAULT_BROWSER_MODEL = 'Xenova/multilingual-e5-small';

function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

// ---- Embedding in the browser (one shared worker, started on first use) ----
let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve(r: Extract<EmbedResponse, { ok: true }>): void; reject(e: Error): void }>();
let onDownload: ((fraction: number) => void) | null = null;

function embedWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' });
  const files = new Map<string, { loaded: number; total: number }>();
  worker.onmessage = (e: MessageEvent<EmbedResponse>) => {
    const msg = e.data;
    if ('progress' in msg) {
      files.set(msg.progress.file, msg.progress);
      let loaded = 0;
      let total = 0;
      files.forEach((f) => ((loaded += f.loaded), (total += f.total)));
      onDownload?.(total ? loaded / total : 0);
      return;
    }
    const entry = waiting.get(msg.id);
    if (!entry) return;
    waiting.delete(msg.id);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.error));
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'Не вдалося запустити модель ембедингів');
    waiting.forEach((w) => w.reject(err));
    waiting.clear();
    worker = null;
  };
  return worker;
}

function browserEmbedder(model: string): Embedder {
  const shortName = model.split('/').pop() ?? model;
  return {
    // Indexes built before the model became a setting carry the short id of the default model.
    id: model === DEFAULT_BROWSER_MODEL ? 'browser:multilingual-e5-small' : `browser:${model}`,
    label: `у браузері (${shortName})`,
    batch: 8,
    async embed(texts, kind) {
      const id = ++seq;
      const result = new Promise<Extract<EmbedResponse, { ok: true }>>((resolve, reject) => waiting.set(id, { resolve, reject }));
      const prefix = taskPrefix(model, kind);
      embedWorker().postMessage({ id, model, texts: prefix ? texts.map((t) => prefix + t) : texts } satisfies EmbedRequest);
      const { dims, data } = await result;
      return texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
    },
  };
}

/** Some embedding models are trained with a task prefix on every text; without it retrieval gets noticeably worse. */
function taskPrefix(model: string, kind: 'query' | 'passage'): string {
  const name = model.toLowerCase();
  if (name.includes('nomic-embed')) return kind === 'query' ? 'search_query: ' : 'search_document: ';
  if (/(^|[^a-z0-9])e5([^a-z0-9]|$)/.test(name)) return kind === 'query' ? 'query: ' : 'passage: ';
  return '';
}

function serverEmbedder(s: Settings): Embedder {
  const base = trimUrl(s.embedBaseUrl);
  return {
    id: `server:${base}|${s.embedModel}`,
    label: `${s.embedModel} (${new URL(base, location.href).host})`,
    batch: 16,
    async embed(texts, kind, signal) {
      const prefix = taskPrefix(s.embedModel, kind);
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: authHeaders(s.embedApiKey, 'embed'),
        body: JSON.stringify({ model: s.embedModel, input: prefix ? texts.map((t) => prefix + t) : texts }),
        signal,
      });
      if (!res.ok) throw new ProviderError(res.status, await readErrorMessage(res), 'local');
      const json = (await res.json()) as { data?: { index?: number; embedding: number[] }[] };
      const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== texts.length) throw new Error('Сервер повернув не стільки ембедингів, скільки було текстів.');
      // Not every server returns unit-length vectors.
      return rows.map((r) => normalize(Float32Array.from(r.embedding)));
    },
  };
}

export function getEmbedder(s: Settings): Embedder | { missing: string } {
  if (s.embedBackend === 'browser') return browserEmbedder(s.embedBrowserModel.trim() || DEFAULT_BROWSER_MODEL);
  if (!trimUrl(s.embedBaseUrl) || !s.embedModel.trim()) return { missing: 'Вкажіть сервер і модель ембедингів у налаштуваннях AI.' };
  return serverEmbedder(s);
}

/** Turns an embedding failure into a message for the reader. */
export function describeEmbedError(err: unknown, s: Settings): string {
  if (s.embedBackend === 'browser') {
    return `Не вдалося запустити модель ембедингів у браузері: ${err instanceof Error ? err.message : String(err)}. Для першого запуску потрібен інтернет.`;
  }
  if (err instanceof TypeError) {
    const hint = isBlockedMixedContent(s.embedBaseUrl) ? MIXED_CONTENT_HINT : 'Перевірте, що він запущений і дозволяє запити з цього сайту.';
    return `Не вдалося з’єднатися із сервером ембедингів ${trimUrl(s.embedBaseUrl)}. ${hint}`;
  }
  if (err instanceof ProviderError && err.status === 404) {
    return `Сервер не знає модель «${s.embedModel}». Для Ollama завантажте її: ollama pull ${s.embedModel}`;
  }
  if (err instanceof ProviderError) return `Сервер ембедингів повернув помилку (${err.status}): ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Splits text into overlapping passages, preferring to cut at sentence ends. */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < MIN_CHUNK) return [];
  if (clean.length <= CHUNK_SIZE) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + CHUNK_SIZE);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('… '));
      const space = window.lastIndexOf(' ');
      if (sentence > CHUNK_SIZE * 0.5) end = start + sentence + 1;
      else if (space > CHUNK_SIZE * 0.5) end = start + space;
    }
    const piece = clean.slice(start, end).trim();
    if (piece.length >= MIN_CHUNK) chunks.push(piece);
    if (end >= clean.length) break;
    // Step back a little so a thought split across two passages is whole in one of them.
    const back = clean.indexOf(' ', Math.max(start + 1, end - CHUNK_OVERLAP));
    start = back > 0 && back < end ? back + 1 : end;
  }
  return chunks;
}

/** Reads the whole book, embeds it passage by passage and stores the index. */
export function buildIndex(opts: Parameters<typeof buildIndexNow>[0]): Promise<VectorIndex | null> {
  return duringWork(buildIndexNow(opts));
}

async function buildIndexNow(opts: {
  /** An open book, or just its text when that has been read already. */
  engine: Pick<Engine, 'unitCount' | 'getUnitText'>;
  bookId: string;
  embedder: Embedder;
  signal: AbortSignal;
  onProgress(p: BuildProgress): void;
}): Promise<VectorIndex | null> {
  const { engine, bookId, embedder, signal, onProgress } = opts;
  const chunks: VectorIndex['chunks'] = [];
  for (let unit = 0; unit < engine.unitCount; unit++) {
    if (signal.aborted) return null;
    const text = await engine.getUnitText(unit).catch(() => '');
    for (const piece of chunkText(text)) chunks.push({ unit, text: piece });
    if (unit % 20 === 0) onProgress({ done: 0, total: 0, status: `Читаю книгу… ${unit + 1} / ${engine.unitCount}` });
  }
  if (!chunks.length) throw new Error('У книзі не знайдено тексту. Для сканів спершу розпізнайте текст (OCR).');
  onProgress({ done: 0, total: chunks.length, status: 'Готую модель ембедингів…' });

  if (embedder.id.startsWith('browser:')) {
    onDownload = (fraction) => onProgress({ done: 0, total: chunks.length, status: `Завантажую модель… ${Math.round(fraction * 100)}%` });
  }
  let vectors: Float32Array | null = null;
  let dims = 0;
  try {
    for (let i = 0; i < chunks.length; i += embedder.batch) {
      if (signal.aborted) return null;
      const batch = await embedder.embed(chunks.slice(i, i + embedder.batch).map((c) => c.text), 'passage', signal);
      if (!vectors) {
        dims = batch[0].length;
        vectors = new Float32Array(chunks.length * dims);
      }
      batch.forEach((v, j) => vectors!.set(v, (i + j) * dims));
      onProgress({ done: Math.min(chunks.length, i + batch.length), total: chunks.length, status: 'Індексую фрагменти…' });
    }
  } finally {
    onDownload = null;
  }
  if (signal.aborted || !vectors) return null;

  const index: VectorIndex = { bookId, model: embedder.id, dims, chunks, vectors, createdAt: Date.now() };
  await db.vectors.put(index);
  return index;
}

export interface VectorHit {
  unit: number;
  text: string;
  score: number;
}

/** Cosine similarity of the query against every passage; returns the best `limit`. */
export async function searchIndex(index: VectorIndex, embedder: Embedder, query: string, limit: number, signal?: AbortSignal): Promise<VectorHit[]> {
  const [q] = await embedder.embed([query], 'query', signal);
  if (q.length !== index.dims) throw new Error('Індекс побудовано іншою моделлю ембедингів — перебудуйте його.');
  return scoreIndex(index, q, limit);
}

/** The best `limit` passages of one index for a query that is already embedded. */
export function scoreIndex(index: VectorIndex, q: Float32Array, limit: number): VectorHit[] {
  const { vectors, dims, chunks } = index;
  const scores = new Float32Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    let dot = 0;
    const row = i * dims;
    for (let d = 0; d < dims; d++) dot += vectors[row + d] * q[d];
    scores[i] = dot;
  }
  const order = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]);
  return order.slice(0, limit).map((i) => ({ unit: chunks[i].unit, text: chunks[i].text, score: scores[i] }));
}
