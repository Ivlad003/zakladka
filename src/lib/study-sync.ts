// Study data between devices: topics, cards (with their review schedule) and memory palaces.
//
//   v1/study.json           everything, in one object
//   v1/study.version.json   a few bytes that change whenever study.json does, so that a sync with
//                           nothing new costs one tiny request
//
// As with books, conflicts are resolved per item and the newest change wins: a card reviewed on the
// phone and edited on the computer keeps whichever happened later. Deletions travel as tombstones.
//
//   v1/study.reviews.json   the log of individual answers (statistics, and fitting the schedule to
//                           the reader); entries are never edited, so two copies merge as a union
import type { Table } from 'dexie';
import { db } from '../db';
import type { MemoryPalace, ReadingDay, ReviewLog, StudyCard, StudyTopic } from '../types';
import { fingerprint } from './hash';
import type { S3Store } from './s3';

const DATA_KEY = 'v1/study.json';
const VERSION_KEY = 'v1/study.version.json';
const STATE_KEY = 'zakladka:studySync';
const REVIEWS_KEY = 'v1/study.reviews.json';
const REVIEWS_STATE_KEY = 'zakladka:reviewSync';

interface StudyData {
  version: 1;
  topics: StudyTopic[];
  cards: StudyCard[];
  palaces: MemoryPalace[];
  /** `t:<id>`, `c:<id>` or `p:<id>` → when it was deleted. */
  deleted: Record<string, number>;
}

/** What this device knew after its last sync. */
interface LocalState {
  /** Version of the remote copy that was last merged in. */
  pulledAt: number;
  digest: string;
}

function readState(): LocalState {
  try {
    return { pulledAt: 0, digest: '', ...JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') };
  } catch {
    return { pulledAt: 0, digest: '' };
  }
}

async function readLocal(): Promise<StudyData> {
  const [topics, cards, palaces, tombs] = await Promise.all([db.topics.toArray(), db.cards.toArray(), db.palaces.toArray(), db.studyTombs.toArray()]);
  return { version: 1, topics, cards, palaces, deleted: Object.fromEntries(tombs.map((t) => [t.id, t.deletedAt])) };
}

/** Which version of every item a copy holds; two copies with the same digest are the same. */
function digestOf(data: StudyData): string {
  const stamp = (kind: string, items: { id: string; updatedAt: number }[]) => items.map((i) => `${kind}:${i.id}:${i.updatedAt}`);
  const parts = [...stamp('t', data.topics), ...stamp('c', data.cards), ...stamp('p', data.palaces), ...Object.entries(data.deleted).map(([id, at]) => `x:${id}:${at}`)];
  return fingerprint(parts.sort().join('\n'));
}

function merge(a: StudyData, b: StudyData): StudyData {
  const deleted: Record<string, number> = { ...b.deleted };
  for (const [id, at] of Object.entries(a.deleted)) deleted[id] = Math.max(deleted[id] ?? 0, at);
  const pick = <T extends { id: string; updatedAt: number }>(kind: string, xs: T[], ys: T[]): T[] => {
    const byId = new Map<string, T>();
    for (const item of [...xs, ...ys]) {
      const known = byId.get(item.id);
      if (!known || item.updatedAt > known.updatedAt) byId.set(item.id, item);
    }
    // Deleted on one device, unless changed somewhere after that.
    return [...byId.values()].filter((item) => (deleted[`${kind}:${item.id}`] ?? 0) < item.updatedAt);
  };
  return { version: 1, topics: pick('t', a.topics, b.topics), cards: pick('c', a.cards, b.cards), palaces: pick('p', a.palaces, b.palaces), deleted };
}

/** Brings the local database to the merged state, without touching what has changed since it was read. */
async function applyMerged(merged: StudyData): Promise<number> {
  let changed = 0;
  await db.transaction('rw', [db.topics, db.cards, db.palaces, db.studyTombs, db.reviews], async () => {
    const bring = async <T extends { id: string; updatedAt: number }>(source: unknown, kind: string, items: T[]) => {
      const table = source as Table<T, string>;
      const wanted = new Set(items.map((i) => i.id));
      for (const item of items) {
        const mine = await table.get(item.id);
        if (!mine || mine.updatedAt < item.updatedAt) {
          await table.put(item);
          changed++;
        }
      }
      for (const mine of await table.toArray()) {
        if (wanted.has(mine.id) || (merged.deleted[`${kind}:${mine.id}`] ?? 0) < mine.updatedAt) continue;
        await table.delete(mine.id);
        if (kind === 'c') await db.reviews.where('cardId').equals(mine.id).delete();
        changed++;
      }
    };
    await bring(db.topics, 't', merged.topics);
    await bring(db.cards, 'c', merged.cards);
    await bring(db.palaces, 'p', merged.palaces);
    await db.studyTombs.bulkPut(Object.entries(merged.deleted).map(([id, deletedAt]) => ({ id, deletedAt })));
  });
  return changed;
}

/**
 * The log of answers. Each device only ever adds to it, so the merged log is everything either side
 * has, minus the answers to cards that were deleted. A count is enough to tell whether a copy has
 * something the other lacks, because entries are never changed or removed one by one.
 */
async function syncReviews(store: S3Store, step: (text: string) => void): Promise<number> {
  const local = await db.reviews.toArray();
  let known = { count: -1, remote: -1 };
  try {
    known = { ...known, ...JSON.parse(localStorage.getItem(REVIEWS_STATE_KEY) ?? '{}') };
  } catch {
    // Compared in full below.
  }
  const listed = await store.getJson<{ count: number }>(`${REVIEWS_KEY}.count`);
  const remoteCount = listed?.count ?? 0;
  if (local.length === known.count && remoteCount === known.remote) return 0;

  step('Синхронізую журнал повторень…');
  const remote = remoteCount ? ((await store.getJson<{ reviews: ReviewLog[] }>(REVIEWS_KEY))?.reviews ?? []) : [];
  const deletedCards = new Set((await db.studyTombs.toArray()).filter((t) => t.id.startsWith('c:')).map((t) => t.id.slice(2)));
  const mine = new Set(local.map((r) => r.id));
  const incoming = remote.filter((r) => !mine.has(r.id) && !deletedCards.has(r.cardId));
  if (incoming.length) await db.reviews.bulkPut(incoming);
  const merged = [...local, ...incoming].filter((r) => !deletedCards.has(r.cardId));
  const theirs = new Set(remote.map((r) => r.id));
  if (merged.length !== remote.length || merged.some((r) => !theirs.has(r.id))) {
    await store.putJson(REVIEWS_KEY, { version: 1, reviews: merged });
    await store.putJson(`${REVIEWS_KEY}.count`, { count: merged.length });
  }
  try {
    localStorage.setItem(REVIEWS_STATE_KEY, JSON.stringify({ count: local.length + incoming.length, remote: merged.length }));
  } catch {
    // Compared in full next time.
  }
  return incoming.length;
}

/**
 * The reading log behind the statistics: one row per day, book and device, each written only by its
 * own device, so the newer copy of a row wins and nothing is counted twice.
 */
async function syncReadingLog(store: S3Store): Promise<number> {
  const KEY = 'v1/reading.json';
  const STATE = 'zakladka:readingSync';
  const local = await db.readingLog.toArray();
  const digest = (rows: ReadingDay[]) => fingerprint(rows.map((r) => `${r.id}:${r.updatedAt}`).sort().join('\n'));
  const version = await store.getJson<{ at: number }>(`${KEY}.version`);
  let known = { at: -1, digest: '' };
  try {
    known = { ...known, ...JSON.parse(localStorage.getItem(STATE) ?? '{}') };
  } catch {
    // Compared in full.
  }
  const mine = digest(local);
  if ((version?.at ?? 0) === known.at && mine === known.digest) return 0;
  const remote = version ? ((await store.getJson<{ days: ReadingDay[] }>(KEY))?.days ?? []) : [];
  const byId = new Map(local.map((r) => [r.id, r]));
  const incoming = remote.filter((r) => (byId.get(r.id)?.updatedAt ?? 0) < r.updatedAt);
  if (incoming.length) await db.readingLog.bulkPut(incoming);
  for (const r of incoming) byId.set(r.id, r);
  const merged = [...byId.values()];
  let at = version?.at ?? 0;
  if (digest(merged) !== digest(remote)) {
    at = Math.max(Date.now(), at + 1);
    await store.putJson(KEY, { version: 1, days: merged });
    await store.putJson(`${KEY}.version`, { at });
  }
  try {
    localStorage.setItem(STATE, JSON.stringify({ at, digest: digest(merged) }));
  } catch {
    // Compared in full next time.
  }
  return incoming.length;
}

/** One round of study sync. Returns how many local items changed and whether anything was uploaded. */
export async function syncStudy(store: S3Store, step: (text: string) => void): Promise<{ pulled: number; pushed: boolean }> {
  const result = await syncItems(store, step);
  // After the cards, so that answers to cards deleted elsewhere are not brought back.
  const reviews = await syncReviews(store, step);
  const reading = await syncReadingLog(store);
  return { pulled: result.pulled + reviews + reading, pushed: result.pushed };
}

async function syncItems(store: S3Store, step: (text: string) => void): Promise<{ pulled: number; pushed: boolean }> {
  const local = await readLocal();
  const state = readState();
  const version = await store.getJson<{ at: number }>(VERSION_KEY);
  const remoteAt = version?.at ?? 0;
  if (remoteAt === state.pulledAt && digestOf(local) === state.digest) return { pulled: 0, pushed: false };

  let merged = local;
  let remoteDigest = '';
  let pulled = 0;
  if (version) {
    step('Синхронізую картки й палаци пам’яті…');
    const remote = await store.getJson<StudyData>(DATA_KEY);
    if (remote) {
      remoteDigest = digestOf(remote);
      merged = merge(local, remote);
      pulled = await applyMerged(merged);
    }
  }

  const digest = digestOf(merged);
  let at = remoteAt;
  const pushed = digest !== remoteDigest && (merged.topics.length > 0 || merged.cards.length > 0 || merged.palaces.length > 0 || Object.keys(merged.deleted).length > 0);
  if (pushed) {
    step('Вивантажую картки й палаци пам’яті…');
    at = Math.max(Date.now(), remoteAt + 1);
    await store.putJson(DATA_KEY, merged);
    await store.putJson(VERSION_KEY, { at });
  }
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ pulledAt: at, digest } satisfies LocalState));
  } catch {
    // Without storage the next sync simply compares everything again.
  }
  return { pulled, pushed };
}
