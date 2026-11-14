// Study: topics, cards and memory palaces, and the review queue built from them.
//
// The method follows what the experimental literature on learning finds reliable:
//   • recalling beats re-reading (testing effect) — so everything is asked as a question;
//   • reviews spread over time beat massed ones (spacing effect) — the scheduler in fsrs.ts;
//   • mixing topics in one session beats blocking them (interleaving) — the queue is shuffled across topics;
//   • a forgotten item is practised again until it is recalled (successive relearning);
//   • vivid images tied to a familiar route are remembered far better than bare facts (method of loci).
import { db } from '../db';
import { getSettings } from '../settings';
import type { BookRecord, MemoryPalace, StudyCard, StudyTopic } from '../types';
import { DAY, newSchedule, review, type Rating } from './fsrs';
import { uid } from './utils';

export interface CardDraft {
  front: string;
  back: string;
  unit?: number;
  label?: string;
  quote?: string;
}

const startOfDay = (time: number) => {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const tomb = (kind: 't' | 'c' | 'p', id: string, at: number) => ({ id: `${kind}:${id}`, deletedAt: at });

// ---- Topics ----

export async function createTopic(input: { title: string; bookId?: string; scope?: string }): Promise<StudyTopic> {
  const now = Date.now();
  const topic: StudyTopic = { id: uid(), title: input.title.trim() || 'Нова тема', bookId: input.bookId, scope: input.scope, createdAt: now, updatedAt: now };
  await db.topics.add(topic);
  return topic;
}

/** The topic cards from this book go to unless another one is named; created on first use. */
export async function topicForBook(book: Pick<BookRecord, 'id' | 'title'>, title?: string): Promise<StudyTopic> {
  const own = await db.topics.where('bookId').equals(book.id).sortBy('createdAt');
  const wanted = title?.trim().toLocaleLowerCase();
  if (wanted) return own.find((t) => t.title.toLocaleLowerCase() === wanted) ?? createTopic({ title: title!, bookId: book.id });
  return own[0] ?? createTopic({ title: book.title, bookId: book.id });
}

export async function updateTopic(id: string, patch: Partial<Pick<StudyTopic, 'title' | 'bookId' | 'scope' | 'recall'>>): Promise<void> {
  await db.topics.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteTopic(id: string): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.topics, db.cards, db.reviews, db.studyTombs, async () => {
    const cards = await db.cards.where('topicId').equals(id).primaryKeys();
    await db.cards.bulkDelete(cards);
    await db.reviews.where('cardId').anyOf(cards).delete();
    await db.topics.delete(id);
    await db.studyTombs.bulkPut([tomb('t', id, now), ...cards.map((c) => tomb('c', c, now))]);
  });
}

// ---- Cards ----

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/** Adds cards to a topic, skipping ones whose question is already there. */
export async function addCards(topic: StudyTopic, drafts: CardDraft[], author: 'user' | 'agent'): Promise<{ added: StudyCard[]; skipped: number }> {
  const now = Date.now();
  const known = new Set((await db.cards.where('topicId').equals(topic.id).toArray()).map((c) => normalize(c.front)));
  const added: StudyCard[] = [];
  for (const draft of drafts) {
    const front = draft.front.trim();
    const back = draft.back.trim();
    if (!front || !back || known.has(normalize(front))) continue;
    known.add(normalize(front));
    added.push({
      id: uid(),
      topicId: topic.id,
      front,
      back,
      bookId: topic.bookId,
      unit: draft.unit,
      label: draft.label,
      quote: draft.quote?.trim() || undefined,
      // A moment apart, so that cards keep the order they were written in.
      ...newSchedule(now + added.length),
      author,
      createdAt: now + added.length,
      updatedAt: now,
    });
  }
  await db.cards.bulkAdd(added);
  return { added, skipped: drafts.length - added.length };
}

export async function updateCard(id: string, patch: Partial<Pick<StudyCard, 'front' | 'back' | 'palaceId' | 'locusId' | 'image' | 'sketch' | 'topicId'>>): Promise<void> {
  await db.cards.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteCard(id: string): Promise<void> {
  await db.transaction('rw', db.cards, db.reviews, db.studyTombs, async () => {
    await db.cards.delete(id);
    await db.reviews.where('cardId').equals(id).delete();
    await db.studyTombs.put(tomb('c', id, Date.now()));
  });
}

/** Records an answer and reschedules the card. */
export async function answerCard(card: StudyCard, rating: Rating, now = Date.now()): Promise<StudyCard> {
  const next = review(card, rating, now, getSettings().studyRetention);
  const updated: StudyCard = { ...card, ...next, introducedAt: card.introducedAt ?? now, updatedAt: now };
  await db.transaction('rw', db.cards, db.reviews, async () => {
    await db.cards.put(updated);
    await db.reviews.add({ id: uid(), cardId: card.id, topicId: card.topicId, at: now, rating, elapsedDays: card.lastReview === undefined ? null : (now - card.lastReview) / DAY });
  });
  return updated;
}

// ---- Queue ----

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const isDue = (card: StudyCard, now: number) => card.state !== 'new' && card.due <= now;

/** New cards the reader may still start today. */
export function newAllowance(cards: StudyCard[], now: number): number {
  const today = startOfDay(now);
  const started = cards.filter((c) => (c.introducedAt ?? 0) >= today).length;
  return Math.max(0, getSettings().studyNewPerDay - started);
}

/**
 * What to ask in a session: everything due, shuffled so that topics alternate, with today's new
 * cards spread evenly between the reviews. `allCards` is the whole collection (it sets how many
 * new cards are still allowed today); `scope` is the part of it this session is about.
 */
export function buildQueue(allCards: StudyCard[], scope: StudyCard[], now: number): StudyCard[] {
  const due = shuffle(scope.filter((c) => isDue(c, now)));
  const fresh = scope
    .filter((c) => c.state === 'new')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, newAllowance(allCards, now));
  if (!fresh.length) return due;
  if (!due.length) return fresh;
  const queue: StudyCard[] = [];
  const every = Math.max(1, Math.floor(due.length / fresh.length));
  let f = 0;
  due.forEach((card, i) => {
    queue.push(card);
    if ((i + 1) % every === 0 && f < fresh.length) queue.push(fresh[f++]);
  });
  return queue.concat(fresh.slice(f));
}

export interface Counts {
  due: number;
  fresh: number;
  total: number;
}

export function countCards(cards: StudyCard[], now: number): Counts {
  let due = 0;
  let fresh = 0;
  for (const c of cards) {
    if (c.state === 'new') fresh++;
    else if (c.due <= now) due++;
  }
  return { due, fresh, total: cards.length };
}

export interface StudyStats {
  reviewedToday: number;
  /** Share of answers other than "Again" on reviews at least a day old, over the last 30 days; `null` with too few of them. */
  retention: number | null;
  /** Days in a row with at least one review, counting today or yesterday as the latest. */
  streak: number;
}

export async function studyStats(now = Date.now()): Promise<StudyStats> {
  const today = startOfDay(now);
  const logs = await db.reviews.where('at').above(now - 60 * DAY).toArray();
  const reviewedToday = logs.filter((l) => l.at >= today).length;
  const mature = logs.filter((l) => l.at >= now - 30 * DAY && l.elapsedDays !== null && l.elapsedDays >= 1);
  const retention = mature.length >= 10 ? mature.filter((l) => l.rating > 1).length / mature.length : null;
  const days = new Set(logs.map((l) => startOfDay(l.at)));
  let streak = 0;
  let day = days.has(today) ? today : today - DAY;
  while (days.has(day)) {
    streak++;
    day = startOfDay(day - DAY / 2);
  }
  return { reviewedToday, retention, streak };
}

// ---- Memory palaces ----

export const PALACE_TEMPLATES: { name: string; loci: string[] }[] = [
  { name: 'Моя квартира', loci: ['Вхідні двері', 'Вішак', 'Дзеркало в передпокої', 'Диван', 'Телевізор', 'Обідній стіл', 'Холодильник', 'Плита', 'Ліжко', 'Письмовий стіл'] },
  { name: 'Дорога на роботу', loci: ['Двері під’їзду', 'Двір', 'Зупинка', 'Перехрестя', 'Магазин на розі', 'Парк', 'Вхід до офісу', 'Робоче місце'] },
  { name: 'Власне тіло', loci: ['Маківка', 'Чоло', 'Ніс', 'Рот', 'Плечі', 'Груди', 'Живіт', 'Коліна', 'Гомілки', 'Стопи'] },
];

export async function createPalace(name: string, lociNames: string[]): Promise<MemoryPalace> {
  const now = Date.now();
  const palace: MemoryPalace = {
    id: uid(),
    name: name.trim() || 'Новий палац',
    loci: lociNames.map((n) => n.trim()).filter(Boolean).map((n) => ({ id: uid(), name: n })),
    createdAt: now,
    updatedAt: now,
  };
  await db.palaces.add(palace);
  return palace;
}

/** Saves the palace; items left at stops that no longer exist are taken out of it. */
export async function savePalace(palace: MemoryPalace): Promise<void> {
  const kept = new Set(palace.loci.map((l) => l.id));
  await db.transaction('rw', db.palaces, db.cards, async () => {
    await db.palaces.put({ ...palace, updatedAt: Date.now() });
    await db.cards
      .where('palaceId')
      .equals(palace.id)
      .filter((c) => !c.locusId || !kept.has(c.locusId))
      .modify({ palaceId: undefined, locusId: undefined, updatedAt: Date.now() });
  });
}

export async function deletePalace(id: string): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.palaces, db.cards, db.studyTombs, async () => {
    await db.cards.where('palaceId').equals(id).modify({ palaceId: undefined, locusId: undefined, updatedAt: now });
    await db.palaces.delete(id);
    await db.studyTombs.put(tomb('p', id, now));
  });
}

/**
 * Leaves each of the given cards at the next stop of the palace, in order, starting after the
 * stops that are already taken. Cards beyond the last stop start a second lap.
 */
export async function placeInOrder(palace: MemoryPalace, cards: StudyCard[]): Promise<number> {
  if (!palace.loci.length) return 0;
  const taken = await db.cards.where('palaceId').equals(palace.id).toArray();
  const load = new Map(palace.loci.map((l) => [l.id, taken.filter((c) => c.locusId === l.id).length]));
  const now = Date.now();
  let placed = 0;
  for (const card of cards) {
    if (card.palaceId === palace.id && card.locusId) continue;
    // The emptiest stop, the earliest among equals: fills the route front to back.
    const locus = palace.loci.reduce((best, l) => ((load.get(l.id) ?? 0) < (load.get(best.id) ?? 0) ? l : best), palace.loci[0]);
    load.set(locus.id, (load.get(locus.id) ?? 0) + 1);
    await db.cards.update(card.id, { palaceId: palace.id, locusId: locus.id, updatedAt: now });
    placed++;
  }
  return placed;
}

// ---- What the AI memory coach may do (see ai/tools.ts) ----

export interface StudyApi {
  /** Cards made from this book, across its topics. */
  listCards(): Promise<StudyCard[]>;
  addCards(drafts: CardDraft[], topicTitle?: string): Promise<{ topic: string; added: number; skipped: number }>;
  listPalaces(): Promise<{ palace: MemoryPalace; cards: StudyCard[] }[]>;
  createPalace(name: string, loci: string[]): Promise<MemoryPalace>;
  /** `palace` and `locus` may be ids, names or (for a stop) its 1-based number. */
  place(palace: string, placements: { card: string; locus: string; image: string }[]): Promise<{ placed: number; problems: string[] }>;
}

export function studyApiFor(book: Pick<BookRecord, 'id' | 'title'>): StudyApi {
  const bookCards = async () => {
    const topics = await db.topics.where('bookId').equals(book.id).primaryKeys();
    return db.cards.where('topicId').anyOf(topics).sortBy('createdAt');
  };
  const same = (a: string, b: string) => normalize(a) === normalize(b);
  return {
    listCards: bookCards,
    async addCards(drafts, topicTitle) {
      const topic = await topicForBook(book, topicTitle);
      const { added, skipped } = await addCards(topic, drafts, 'agent');
      return { topic: topic.title, added: added.length, skipped };
    },
    async listPalaces() {
      const palaces = await db.palaces.orderBy('id').toArray();
      const placed = await db.cards.filter((c) => Boolean(c.palaceId)).toArray();
      return palaces.sort((a, b) => a.createdAt - b.createdAt).map((palace) => ({ palace, cards: placed.filter((c) => c.palaceId === palace.id) }));
    },
    createPalace,
    async place(palaceRef, placements) {
      const palaces = await db.palaces.toArray();
      const palace = palaces.find((p) => p.id === palaceRef || p.id.startsWith(palaceRef) || same(p.name, palaceRef)) ?? (palaces.length === 1 ? palaces[0] : undefined);
      if (!palace) return { placed: 0, problems: [`No memory palace "${palaceRef}". Existing: ${palaces.map((p) => `"${p.name}"`).join(', ') || 'none'}.`] };
      const cards = await bookCards();
      const problems: string[] = [];
      let placed = 0;
      const now = Date.now();
      for (const item of placements) {
        const card = cards.find((c) => c.id === item.card || c.id.startsWith(item.card));
        const index = /^\d+$/.test(item.locus.trim()) ? Number(item.locus) - 1 : -1;
        const locus = palace.loci.find((l) => l.id === item.locus || same(l.name, item.locus)) ?? palace.loci[index];
        if (!card) problems.push(`No card "${item.card}".`);
        else if (!locus) problems.push(`No stop "${item.locus}" in "${palace.name}".`);
        else {
          await db.cards.update(card.id, { palaceId: palace.id, locusId: locus.id, image: item.image.trim() || undefined, updatedAt: now });
          placed++;
        }
      }
      return { placed, problems };
    },
  };
}
