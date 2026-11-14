// Reading statistics: how long and how much is read, day by day.
//
// While a book is open and on screen, time counts as reading as long as the reader does something
// now and then (turns a page, scrolls, touches the screen) — after three quiet minutes it stops
// counting, so a book left open on the table does not inflate the numbers. Pages are screens turned
// (a page of a PDF, a screen of an EPUB). Each device keeps its own rows, so sync adds devices up
// instead of counting the same minutes twice.
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { BookRecord, ReadingDay } from '../types';

const IDLE_MS = 3 * 60_000;
const TICK_MS = 15_000;
const FLUSH_MS = 60_000;
/** Progress at which a book counts as read. */
const FINISHED_AT = 0.985;

/** This device's id in the reading log (not secret, only tells devices apart). */
export function deviceId(): string {
  try {
    let id = localStorage.getItem('zakladka:device');
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      localStorage.setItem('zakladka:device', id);
    }
    return id;
  } catch {
    return 'this';
  }
}

export const dayKey = (time: number): string => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export interface Tracker {
  /** A page turned or the position moved, with the book's progress (0..1) after it. */
  moved(progress: number): void;
  /** Where the book is shown, without a page having been read (opened, laid out again). */
  at(progress: number): void;
  /** Any sign of the reader being there: a touch, a key, a scroll. */
  activity(): void;
  /** Writes what was counted (when the book is closed or the app hidden). */
  flush(): Promise<void>;
  stop(): void;
}

/** Counts reading time and pages for the open book. */
export function startTracking(bookId: string): Tracker {
  const device = deviceId();
  let lastActivity = Date.now();
  let lastTick = Date.now();
  let seconds = 0;
  let pages = 0;
  let gain = 0;
  let lastProgress: number | null = null;
  let stopped = false;

  const flush = async () => {
    if (!seconds && !pages && !gain) return;
    const add = { seconds, pages, gain };
    seconds = 0;
    pages = 0;
    gain = 0;
    const day = dayKey(Date.now());
    const id = `${day}|${bookId}|${device}`;
    await db.transaction('rw', db.readingLog, async () => {
      const row = await db.readingLog.get(id);
      await db.readingLog.put({
        id,
        day,
        bookId,
        device,
        seconds: Math.round((row?.seconds ?? 0) + add.seconds),
        pages: (row?.pages ?? 0) + add.pages,
        progressGain: (row?.progressGain ?? 0) + add.gain,
        updatedAt: Date.now(),
      });
    });
  };

  const tick = () => {
    const now = Date.now();
    const elapsed = Math.min(now - lastTick, TICK_MS * 2);
    lastTick = now;
    if (document.visibilityState === 'visible' && now - lastActivity < IDLE_MS) seconds += elapsed / 1000;
  };
  const ticker = setInterval(tick, TICK_MS);
  const flusher = setInterval(() => void flush(), FLUSH_MS);
  const onHide = () => {
    tick();
    void flush();
  };
  const onVisible = () => {
    lastTick = Date.now();
  };
  const visibility = () => (document.visibilityState === 'hidden' ? onHide() : onVisible());
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', onHide);

  return {
    moved(progress) {
      lastActivity = Date.now();
      // The first report is where the book opened, not a page read.
      if (lastProgress === null) {
        lastProgress = progress;
        return;
      }
      pages++;
      if (progress > lastProgress && progress - lastProgress < 0.2) gain += progress - lastProgress;
      lastProgress = progress;
      if (progress >= FINISHED_AT) void markFinished(bookId);
    },
    at(progress) {
      lastProgress = progress;
    },
    activity() {
      lastActivity = Date.now();
    },
    flush: async () => {
      tick();
      await flush();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      tick();
      clearInterval(ticker);
      clearInterval(flusher);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', onHide);
      void flush();
    },
  };
}

/** Marks a book as read (once); it then counts towards the year's goal. */
export async function markFinished(bookId: string, finished = true): Promise<void> {
  const book = await db.books.get(bookId);
  if (!book || Boolean(book.finishedAt) === finished) return;
  const now = Date.now();
  await db.books.update(bookId, { finishedAt: finished ? now : 0, infoAt: now });
}

// ---- Reading the log ----

export interface DayTotal {
  day: string;
  seconds: number;
  pages: number;
}

/** Totals per day for the last `days` days, oldest first, days without reading included. */
export function lastDays(rows: ReadingDay[], days: number, now = Date.now()): DayTotal[] {
  const byDay = new Map<string, DayTotal>();
  for (const r of rows) {
    const t = byDay.get(r.day) ?? { day: r.day, seconds: 0, pages: 0 };
    t.seconds += r.seconds;
    t.pages += r.pages;
    byDay.set(r.day, t);
  }
  const out: DayTotal[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = dayKey(d.getTime());
    out.push(byDay.get(key) ?? { day: key, seconds: 0, pages: 0 });
  }
  return out;
}

/** Days in a row with at least a minute of reading, ending today (or yesterday, if today has none yet), and the longest run. */
export function streaks(rows: ReadingDay[], now = Date.now()): { current: number; longest: number } {
  const minutes = new Map<string, number>();
  for (const r of rows) minutes.set(r.day, (minutes.get(r.day) ?? 0) + r.seconds);
  const read = (key: string) => (minutes.get(key) ?? 0) >= 60;
  const back = (from: number, n: number) => {
    const d = new Date(from);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return dayKey(d.getTime());
  };
  let start = read(dayKey(now)) ? 0 : 1;
  let current = 0;
  while (read(back(now, start + current))) current++;
  if (start === 1 && current === 0) start = 0;
  // The longest run, over all days with reading.
  const days = [...minutes.keys()].filter(read).sort();
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const key of days) {
    const t = new Date(`${key}T12:00:00`).getTime();
    run = previous !== null && Math.round((t - previous) / 86_400_000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = t;
  }
  return { current, longest: Math.max(longest, current) };
}

export interface BookPace {
  seconds: number;
  pages: number;
  /** Seconds a page takes this reader in this book, when there is enough to tell. */
  secondsPerPage: number | null;
  /** Share of the book read per second of reading, when there is enough to tell. */
  progressPerSecond: number | null;
}

/** How fast a book is being read; falls back to the reader's pace across all books for pages. */
export function paceOf(rows: ReadingDay[], bookId: string): BookPace {
  let seconds = 0;
  let pages = 0;
  let gain = 0;
  let allSeconds = 0;
  let allPages = 0;
  for (const r of rows) {
    allSeconds += r.seconds;
    allPages += r.pages;
    if (r.bookId !== bookId) continue;
    seconds += r.seconds;
    pages += r.pages;
    gain += r.progressGain;
  }
  const own = seconds >= 300 && pages >= 5 ? seconds / pages : null;
  const overall = allSeconds >= 600 && allPages >= 10 ? allSeconds / allPages : null;
  return {
    seconds,
    pages,
    secondsPerPage: own ?? overall,
    progressPerSecond: seconds >= 300 && gain > 0.005 ? gain / seconds : null,
  };
}

/** "8 хв", "1 год 20 хв". */
export function durationLabel(seconds: number): string {
  if (seconds < 45) return '<1 хв';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} хв`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} год ${rest} хв` : `${hours} год`;
}

export function useReadingLog(): ReadingDay[] | undefined {
  return useLiveQuery(() => db.readingLog.toArray(), []);
}

export const finishedThisYear = (books: BookRecord[], now = Date.now()): BookRecord[] => {
  const year = new Date(now).getFullYear();
  return books.filter((b) => b.finishedAt && new Date(b.finishedAt).getFullYear() === year).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
};
