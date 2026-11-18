// Cross-device sync through S3-compatible storage (RustFS, MinIO, …).
//
// Layout in the bucket (under the optional prefix):
//   v1/index.json                 list of books with the version of each one's state
//   v1/books/<id>/meta.json       title, author, format… (written once)
//   v1/books/<id>/cover           cover image
//   v1/books/<id>/file            the book itself (written once, downloaded on first open)
//   v1/books/<id>/state.json      reading position, highlights, notes, bookmarks, drawings
//   v1/books/<id>/ocr.json        recognised text of scanned pages
//
// Conflicts are resolved per item, newest change wins: each highlight/note, each page of drawings
// and the reading position carry their own timestamp. Deletions are kept as tombstones so they
// propagate instead of being undone by another device. Settings and API keys are never synced,
// and neither are AI conversations or semantic-search indexes. Study cards and memory palaces are
// synced by study-sync.ts.
import { duringWork } from './busy';
import { useSyncExternalStore } from 'react';
import { db, deleteBook } from '../db';
import { getSettings, type Settings } from '../settings';
import type { Annotation, BookFormat, BookRecord, InkPage, OcrPage, SyncMeta } from '../types';
import { fingerprint } from './hash';
import { describeS3Error, S3Store, type S3Config } from './s3';
import { syncChats } from './chat-sync';
import { syncStudy } from './study-sync';
import { formatBytes } from './utils';

const INDEX_KEY = 'v1/index.json';
const bookKey = (id: string, name: string) => `v1/books/${id}/${name}`;
const BOOK_OBJECTS = ['file', 'cover', 'meta.json', 'state.json', 'ocr.json'];

interface RemoteBookEntry {
  title: string;
  addedAt: number;
  /** Version of state.json: changes whenever some device uploads it. 0 = never uploaded. */
  stateAt: number;
  ocrAt?: number;
  /** Set when the book was deleted on some device. */
  deletedAt?: number;
}

interface RemoteIndex {
  version: 1;
  books: Record<string, RemoteBookEntry>;
}

interface RemoteMeta {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  size: number;
  fileName: string;
  addedAt: number;
  unitCount: number;
  hasCover: boolean;
  /** Where the book came from (a saved article, a book made from a repository); absent in older uploads. */
  sourceUrl?: string;
  made?: BookRecord['made'];
}

interface BookState {
  position: { value: string | null; progress: number; lastOpenedAt: number; at: number };
  annotations: Annotation[];
  /** Annotation id → time of deletion. */
  deletedAnnotations: Record<string, number>;
  ink: InkPage[];
  /** Title, author and shelves as the reader edited them; absent until they do. */
  info?: { title: string; author: string; tags: string[]; at: number; finishedAt?: number };
}

interface RemoteOcr {
  pages: OcrPage[];
}

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  updated: number;
  removed: number;
}

// ---- Status shown in the UI ----
export interface SyncStatus {
  running: boolean;
  /** What is happening right now. */
  step: string;
  lastSyncAt: number | null;
  lastReport: SyncReport | null;
  error: string | null;
}

const LAST_SYNC_KEY = 'zakladka:lastSync';

function readLastSync(): number | null {
  try {
    return Number(localStorage.getItem(LAST_SYNC_KEY)) || null;
  } catch {
    return null;
  }
}

let status: SyncStatus = { running: false, step: '', lastSyncAt: readLastSync(), lastReport: null, error: null };
const listeners = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribe, () => status);
}

/** The storage settings, or null while sync is not set up. */
export function syncConfig(s: Settings = getSettings()): S3Config | null {
  if (!s.s3Endpoint.trim() || !s.s3Bucket.trim() || !s.s3AccessKey.trim() || !s.s3SecretKey.trim()) return null;
  return {
    endpoint: s.s3Endpoint,
    region: s.s3Region,
    bucket: s.s3Bucket,
    accessKey: s.s3AccessKey.trim(),
    secretKey: s.s3SecretKey.trim(),
    prefix: s.s3Prefix,
  };
}

// ---- Reading state of one book ----

/** Which version of every item a state holds; two states with the same digest are the same. */
function digestOf(state: BookState): string {
  return fingerprint(
    [
      `p${state.position.at}`,
      ...state.annotations.map((a) => `a${a.id}:${a.updatedAt}`).sort(),
      ...Object.entries(state.deletedAnnotations)
        .map(([id, at]) => `d${id}:${at}`)
        .sort(),
      ...state.ink.map((p) => `i${p.page}:${p.updatedAt ?? 0}`).sort(),
      // Only when present, so that books nobody has edited keep the digest they had.
      ...(state.info ? [`n${state.info.at}`] : []),
    ].join('|'),
  );
}

const EMPTY_STATE: BookState = { position: { value: null, progress: 0, lastOpenedAt: 0, at: 0 }, annotations: [], deletedAnnotations: {}, ink: [] };
const EMPTY_DIGEST = digestOf(EMPTY_STATE);

/** Positions saved before sync existed carry no timestamp; the last time the book was opened stands in for it. */
const positionAt = (book: BookRecord) => book.positionAt ?? (book.position === null ? 0 : book.lastOpenedAt);

async function readLocalState(bookId: string): Promise<{ state: BookState; digest: string } | null> {
  return db.transaction('r', db.books, db.annotations, db.ink, db.tombstones, async () => {
    const book = await db.books.get(bookId);
    if (!book) return null;
    const [annotations, ink, tombstones] = await Promise.all([
      db.annotations.where('bookId').equals(bookId).toArray(),
      db.ink.where('bookId').equals(bookId).toArray(),
      db.tombstones.where('bookId').equals(bookId).toArray(),
    ]);
    const deletedAnnotations: Record<string, number> = {};
    for (const t of tombstones) if (t.kind === 'annotation') deletedAnnotations[t.id.slice(2)] = t.deletedAt;
    const state: BookState = {
      position: { value: book.position, progress: book.progress, lastOpenedAt: book.lastOpenedAt, at: positionAt(book) },
      annotations,
      deletedAnnotations,
      ink,
      ...(book.infoAt ? { info: { title: book.title, author: book.author, tags: book.tags ?? [], at: book.infoAt, finishedAt: book.finishedAt ?? 0 } } : {}),
    };
    return { state, digest: digestOf(state) };
  });
}

/**
 * Brings in everything the remote state knows better: items this device lacks and items changed
 * more recently elsewhere. Runs in one transaction against the rows as they are right now, so
 * something the reader does while a sync is under way is never overwritten by older data.
 */
async function applyRemoteState(bookId: string, remote: BookState): Promise<void> {
  await db.transaction('rw', db.books, db.annotations, db.ink, db.tombstones, async () => {
    const book = await db.books.get(bookId);
    if (!book) return;

    const deleted = new Map<string, number>();
    for (const t of await db.tombstones.where('bookId').equals(bookId).toArray()) {
      if (t.kind === 'annotation') deleted.set(t.id.slice(2), t.deletedAt);
    }
    for (const [id, at] of Object.entries(remote.deletedAnnotations ?? {})) {
      if (at <= (deleted.get(id) ?? 0)) continue;
      deleted.set(id, at);
      await db.tombstones.put({ id: `a:${id}`, kind: 'annotation', bookId, deletedAt: at });
    }

    const mine = new Map((await db.annotations.where('bookId').equals(bookId).toArray()).map((a) => [a.id, a]));
    // A deletion wins unless the item was edited after it.
    for (const [id, at] of deleted) {
      const a = mine.get(id);
      if (a && a.updatedAt <= at) {
        await db.annotations.delete(id);
        mine.delete(id);
      }
    }
    for (const a of remote.annotations ?? []) {
      if (a.updatedAt <= (deleted.get(a.id) ?? 0)) continue;
      const known = mine.get(a.id);
      if (!known || a.updatedAt > known.updatedAt) await db.annotations.put(a);
    }

    const pages = new Map((await db.ink.where('bookId').equals(bookId).toArray()).map((p) => [p.page, p]));
    for (const page of remote.ink ?? []) {
      const known = pages.get(page.page);
      if (!known || (page.updatedAt ?? 0) > (known.updatedAt ?? 0)) await db.ink.put(page);
    }

    const patch: Partial<BookRecord> = {};
    const p = remote.position;
    if (p && (p.at > positionAt(book) || (book.position === null && p.value !== null))) {
      patch.position = p.value;
      patch.progress = p.progress;
      patch.positionAt = p.at;
    }
    if (p && p.lastOpenedAt > book.lastOpenedAt) patch.lastOpenedAt = p.lastOpenedAt;
    const info = remote.info;
    if (info && info.at > (book.infoAt ?? 0)) {
      patch.title = info.title;
      patch.author = info.author;
      patch.tags = info.tags;
      patch.infoAt = info.at;
      if (info.finishedAt !== undefined) patch.finishedAt = info.finishedAt;
    }
    if (Object.keys(patch).length) await db.books.update(bookId, patch);
  });
}

const ocrDigestOf = (pages: OcrPage[]) =>
  fingerprint(
    pages
      .map((p) => `${p.page}:${p.createdAt}`)
      .sort()
      .join('|'),
  );
const emptyMeta = (bookId: string): SyncMeta => ({ bookId, stateDigest: EMPTY_DIGEST, pulledStateAt: 0, ocrDigest: ocrDigestOf([]), ocrPulledAt: 0 });
/** Version stamps only need to change on every upload; they are compared for equality, not order. */
const nextVersion = (previous: number | undefined) => Math.max(Date.now(), (previous ?? 0) + 1);

async function loadIndex(store: S3Store): Promise<RemoteIndex> {
  const index = await store.getJson<RemoteIndex>(INDEX_KEY);
  return index && typeof index.books === 'object' && index.books ? index : { version: 1, books: {} };
}

async function runSync(store: S3Store, step: (text: string) => void): Promise<SyncReport> {
  const report: SyncReport = { uploaded: 0, downloaded: 0, updated: 0, removed: 0 };

  step('Читаю список книг у сховищі…');
  const index = await loadIndex(store);
  /** Versions as they were when this run started, to notice another device writing meanwhile. */
  const seen = new Map(Object.entries(index.books).map(([id, e]) => [id, { stateAt: e.stateAt, ocrAt: e.ocrAt ?? 0 }]));
  /** Entries this run changed (null = removed), replayed onto a fresh copy of the index at the end. */
  const touched = new Map<string, RemoteBookEntry | null>();
  const touch = (id: string) => touched.set(id, index.books[id] ?? null);

  // 1. Books deleted on this device: remove their objects and record the deletion for the others.
  for (const tomb of await db.tombstones.where('kind').equals('book').toArray()) {
    const id = tomb.bookId;
    const entry = index.books[id];
    if (!entry || (entry.deletedAt ?? 0) >= tomb.deletedAt) continue;
    if (await db.books.get(id)) continue; // added again since
    if (!entry.deletedAt && entry.addedAt > tomb.deletedAt) {
      await db.tombstones.delete(tomb.id); // another device added it again after the deletion
      continue;
    }
    step(`Видаляю зі сховища «${entry.title}»…`);
    await Promise.all(BOOK_OBJECTS.map((name) => store.delete(bookKey(id, name))));
    index.books[id] = { title: entry.title, addedAt: entry.addedAt, stateAt: entry.stateAt, deletedAt: tomb.deletedAt };
    touch(id);
    report.removed++;
  }

  // 2. Books deleted elsewhere: remove them here too, unless they were added again after that.
  for (const [id, entry] of Object.entries(index.books)) {
    if (!entry.deletedAt) continue;
    const local = await db.books.get(id);
    if (!local) continue;
    if (local.addedAt > entry.deletedAt) {
      delete index.books[id]; // uploaded afresh below
      touch(id);
      continue;
    }
    await deleteBook(id);
    // Keep the original time of deletion so that this device does not announce it as a new one.
    await db.tombstones.put({ id: `b:${id}`, kind: 'book', bookId: id, deletedAt: entry.deletedAt });
    report.removed++;
  }

  // 3. Books that exist only in the storage: list them here; the file itself is fetched on first open.
  for (const [id, entry] of Object.entries(index.books)) {
    if (entry.deletedAt || (await db.books.get(id))) continue;
    step(`Додаю «${entry.title}» зі сховища…`);
    const meta = await store.getJson<RemoteMeta>(bookKey(id, 'meta.json'));
    if (!meta) continue; // another device is still uploading it
    const cover = meta.hasCover ? await store.getBlob(bookKey(id, 'cover')) : null;
    await db.transaction('rw', db.books, db.tombstones, db.syncMeta, async () => {
      await db.tombstones.delete(`b:${id}`);
      await db.syncMeta.delete(id);
      await db.books.put({
        id,
        title: meta.title,
        author: meta.author,
        format: meta.format,
        size: meta.size,
        fileName: meta.fileName,
        addedAt: meta.addedAt,
        lastOpenedAt: 0,
        progress: 0,
        position: null,
        unitCount: meta.unitCount,
        cover,
        cloudOnly: true,
        ...(meta.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
        ...(meta.made ? { made: meta.made } : {}),
      });
    });
    report.downloaded++;
  }

  // 4. Every book: upload it if the storage does not have it yet, then exchange reading state.
  for (const book of await db.books.toArray()) {
    let meta = (await db.syncMeta.get(book.id)) ?? emptyMeta(book.id);
    let entry = index.books[book.id];

    if (!entry) {
      const file = book.cloudOnly ? undefined : await db.files.get(book.id);
      if (!file) continue;
      step(`Вивантажую «${book.title}» (${formatBytes(book.size)})…`);
      await store.putBlob(bookKey(book.id, 'file'), file.data);
      if (book.cover) await store.putBlob(bookKey(book.id, 'cover'), book.cover);
      const remoteMeta: RemoteMeta = {
        id: book.id,
        title: book.title,
        author: book.author,
        format: book.format,
        size: book.size,
        fileName: book.fileName,
        addedAt: book.addedAt,
        unitCount: book.unitCount,
        hasCover: Boolean(book.cover),
        ...(book.sourceUrl ? { sourceUrl: book.sourceUrl } : {}),
        ...(book.made ? { made: book.made } : {}),
      };
      // meta.json goes last: its presence tells other devices that the upload is complete.
      await store.putJson(bookKey(book.id, 'meta.json'), remoteMeta);
      entry = index.books[book.id] = { title: book.title, addedAt: book.addedAt, stateAt: 0 };
      touch(book.id);
      meta = emptyMeta(book.id); // whatever was exchanged before was with another storage
      report.uploaded++;
    }

    // Position, highlights, notes, bookmarks, drawings.
    let local = await readLocalState(book.id);
    if (!local) continue; // deleted while the sync was running
    let upload: boolean;
    if (entry.stateAt !== meta.pulledStateAt) {
      const remote = entry.stateAt ? await store.getJson<BookState>(bookKey(book.id, 'state.json')) : null;
      if (remote) {
        const before = local.digest;
        await applyRemoteState(book.id, remote);
        local = (await readLocalState(book.id)) ?? local;
        if (local.digest !== before) report.updated++;
      }
      upload = local.digest !== (remote ? digestOf({ ...EMPTY_STATE, ...remote }) : EMPTY_DIGEST);
      meta.pulledStateAt = entry.stateAt;
      meta.stateDigest = local.digest;
    } else {
      upload = local.digest !== meta.stateDigest;
    }
    if (upload) {
      await store.putJson(bookKey(book.id, 'state.json'), local.state);
      entry.stateAt = nextVersion(entry.stateAt);
      touch(book.id);
      meta.pulledStateAt = entry.stateAt;
      meta.stateDigest = local.digest;
      report.updated++;
    }

    // Recognised text of scanned pages: the union of what the devices have, newest recognition wins.
    let pages = await db.ocr.where('bookId').equals(book.id).toArray();
    let uploadOcr: boolean;
    if ((entry.ocrAt ?? 0) !== meta.ocrPulledAt) {
      const remoteOcr = entry.ocrAt ? await store.getJson<RemoteOcr>(bookKey(book.id, 'ocr.json')) : null;
      const remotePages = remoteOcr?.pages ?? [];
      const byPage = new Map(pages.map((p) => [p.page, p]));
      const incoming = remotePages.filter((p) => (byPage.get(p.page)?.createdAt ?? 0) < p.createdAt);
      if (incoming.length) {
        await db.ocr.bulkPut(incoming);
        incoming.forEach((p) => byPage.set(p.page, p));
        pages = [...byPage.values()];
      }
      meta.ocrPulledAt = entry.ocrAt ?? 0;
      meta.ocrDigest = ocrDigestOf(pages);
      uploadOcr = pages.length > 0 && meta.ocrDigest !== ocrDigestOf(remotePages);
    } else {
      // Text cleared on this device stays in the storage: other devices may still want it.
      uploadOcr = pages.length > 0 && ocrDigestOf(pages) !== meta.ocrDigest;
    }
    if (uploadOcr) {
      step(`Вивантажую розпізнаний текст «${book.title}»…`);
      await store.putJson(bookKey(book.id, 'ocr.json'), { pages } satisfies RemoteOcr);
      entry.ocrAt = nextVersion(entry.ocrAt);
      touch(book.id);
      meta.ocrPulledAt = entry.ocrAt;
      meta.ocrDigest = ocrDigestOf(pages);
    }

    await db.syncMeta.put(meta);
  }

  if (touched.size) {
    step('Оновлюю список книг у сховищі…');
    // Re-read the index right before writing it, so that a long upload does not wipe out what
    // another device has recorded in the meantime.
    const fresh = await loadIndex(store);
    for (const [id, entry] of touched) {
      if (!entry) {
        delete fresh.books[id];
        continue;
      }
      const theirs = fresh.books[id];
      const before = seen.get(id);
      if (theirs && before && !entry.deletedAt && !theirs.deletedAt) {
        const theyChangedState = theirs.stateAt !== before.stateAt;
        const theyChangedOcr = (theirs.ocrAt ?? 0) !== before.ocrAt;
        const weChangedState = entry.stateAt !== before.stateAt;
        const weChangedOcr = (entry.ocrAt ?? 0) !== before.ocrAt;
        // Both devices uploaded at once: forget what was exchanged, so that the next run merges
        // again. The other device does the same when it sees the version change.
        if ((theyChangedState && weChangedState) || (theyChangedOcr && weChangedOcr)) await db.syncMeta.delete(id);
        if (theyChangedState && !weChangedState) entry.stateAt = theirs.stateAt;
        if (theyChangedOcr && !weChangedOcr) entry.ocrAt = theirs.ocrAt;
      }
      fresh.books[id] = entry;
    }
    await store.putJson(INDEX_KEY, fresh);
  }

  // Study data — topics, cards with their review schedule, memory palaces — travels separately from the books.
  const study = await syncStudy(store, step);
  report.updated += study.pulled;
  // So do the conversations with the agents.
  const chats = await syncChats(store, step);
  report.updated += chats.pulled;
  report.uploaded += chats.pushed;
  return report;
}

let running: Promise<SyncReport | null> | null = null;
let runAgain = false;

/**
 * Runs a full sync. A call made while one is running asks for another pass right after it, so that
 * changes made in the meantime are not left behind. Never rejects: failures land in the status.
 */
export function syncNow(): Promise<SyncReport | null> {
  if (running) {
    runAgain = true;
    return running;
  }
  running = duringWork((async () => {
    const config = syncConfig();
    if (!config) return null;
    setStatus({ running: true, step: 'З’єднуюся зі сховищем…', error: null });
    try {
      const store = new S3Store(config);
      const total: SyncReport = { uploaded: 0, downloaded: 0, updated: 0, removed: 0 };
      do {
        runAgain = false;
        const report = await runSync(store, (step) => setStatus({ step }));
        for (const key of Object.keys(total) as (keyof SyncReport)[]) total[key] += report[key];
      } while (runAgain);
      const now = Date.now();
      try {
        localStorage.setItem(LAST_SYNC_KEY, String(now));
      } catch {
        // Not essential.
      }
      setStatus({ running: false, step: '', lastSyncAt: now, lastReport: total });
      return total;
    } catch (err) {
      setStatus({ running: false, step: '', error: describeS3Error(err, config) });
      return null;
    } finally {
      running = null;
      runAgain = false;
    }
  })());
  return running;
}

let lastAutoSync = 0;

/** Background sync: only when it is set up and switched on, and — unless forced — at most every 20 seconds. */
export function autoSync(force = false): void {
  if (!getSettings().syncAuto || !syncConfig() || !navigator.onLine) return;
  if (!force && Date.now() - lastAutoSync < 20_000) return;
  lastAutoSync = Date.now();
  void syncNow();
}

/** Fetches the file of a book that so far exists on this device only as a library entry. */
export async function downloadBookFile(bookId: string): Promise<Blob> {
  const config = syncConfig();
  if (!config) throw new Error('Файл цієї книги лежить у хмарному сховищі, а синхронізацію на цьому пристрої не налаштовано.');
  let blob: Blob | null;
  try {
    blob = await new S3Store(config).getBlob(bookKey(bookId, 'file'));
  } catch (err) {
    throw new Error(describeS3Error(err, config));
  }
  if (!blob) throw new Error('Файлу цієї книги у сховищі немає. Можливо, пристрій, що її додав, ще не закінчив вивантаження.');
  const data = blob;
  await db.transaction('rw', db.books, db.files, async () => {
    await db.files.put({ bookId, data });
    await db.books.update(bookId, { cloudOnly: false });
  });
  return data;
}

/** Whether the book has reached the storage, i.e. its file can be removed from this device and fetched again later. */
export async function isBookInStorage(bookId: string): Promise<boolean> {
  return Boolean(syncConfig()) && Boolean(await db.syncMeta.get(bookId));
}

/** Frees space on this device: drops the file but keeps the book in the library, to be downloaded again when opened. */
export async function removeLocalCopy(bookId: string): Promise<void> {
  await db.transaction('rw', db.books, db.files, async () => {
    await db.files.delete(bookId);
    await db.books.update(bookId, { cloudOnly: true });
  });
}

export type ConnectionCheck = { ok: true; bucketExists: boolean } | { ok: false; error: string };

/** Checks storage settings before they are saved; can create the bucket on the way. */
export async function testConnection(config: S3Config, createBucket = false): Promise<ConnectionCheck> {
  try {
    const store = new S3Store(config);
    if (createBucket) await store.createBucket();
    return { ok: true, bucketExists: await store.bucketExists() };
  } catch (err) {
    return { ok: false, error: describeS3Error(err, config) };
  }
}
