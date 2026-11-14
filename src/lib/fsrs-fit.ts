// Fitting the schedule to the reader.
//
// FSRS ships with parameters fitted to a large population. The four that matter most at the start
// are the initial stabilities: how many days a brand-new card lasts after its first answer ("again",
// "hard", "good", "easy"). People differ here a lot, and these four can be estimated from little
// data, the way the FSRS optimizer does in its first ("pretrain") step: take every card's first
// answer, look at whether the card was remembered the next time it came up on a later day, and find
// the stability that best explains those outcomes under the forgetting curve.
//
// The estimate is pulled towards the published default, so a handful of answers moves it little and
// only real evidence moves it far. The other fifteen parameters stay at their defaults: fitting them
// needs thousands of reviews and a proper optimizer.
import { db } from '../db';
import type { ReviewLog } from '../types';
import { DAY, DEFAULT_INITIAL_STABILITY, retrievability, setInitialStability, type Rating } from './fsrs';

export interface ScheduleFit {
  /** Initial stability in days per first answer (again, hard, good, easy). */
  stability: [number, number, number, number];
  /** How many first-answer → later-review pairs each one rests on. */
  samples: [number, number, number, number];
  fittedAt: number;
}

/** Pairs needed before a first answer's stability is moved at all. */
export const MIN_SAMPLES = 8;
const STORE_KEY = 'zakladka:scheduleFit';
/** Strength of the pull towards the default, in units of "observations". */
const PRIOR = 3;

const startOfDay = (time: number) => {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** For every card: its first answer, and what happened the first time it was seen on a later day. */
function firstOutcomes(logs: ReviewLog[]): { rating: Rating; days: number; recalled: boolean }[] {
  const byCard = new Map<string, ReviewLog[]>();
  for (const log of logs) {
    const list = byCard.get(log.cardId);
    if (list) list.push(log);
    else byCard.set(log.cardId, [log]);
  }
  const out: { rating: Rating; days: number; recalled: boolean }[] = [];
  for (const list of byCard.values()) {
    list.sort((a, b) => a.at - b.at);
    const first = list[0];
    // Only cards whose history is whole: the first log must be the first answer.
    if (first.elapsedDays !== null) continue;
    const day = startOfDay(first.at);
    const later = list.find((l) => startOfDay(l.at) > day);
    if (!later) continue;
    out.push({ rating: first.rating, days: Math.max(1, Math.round((startOfDay(later.at) - day) / DAY)), recalled: later.rating > 1 });
  }
  return out;
}

/** The stability that best explains the outcomes, with a pull towards `fallback`. */
function fitOne(outcomes: { days: number; recalled: boolean }[], fallback: number): number {
  let best = fallback;
  let bestLoss = Infinity;
  // A grid in log space is plenty: the loss has one minimum and the answer is rounded to a day anyway.
  for (let i = 0; i <= 240; i++) {
    const s = 0.1 * Math.pow(1000, i / 240); // 0.1 … 100 days
    let loss = PRIOR * Math.pow(Math.log(s / fallback), 2);
    for (const o of outcomes) {
      const r = Math.min(0.9999, Math.max(0.0001, retrievability(o.days, s)));
      loss -= o.recalled ? Math.log(r) : Math.log(1 - r);
    }
    if (loss < bestLoss) {
      bestLoss = loss;
      best = s;
    }
  }
  return best;
}

/** Estimates the reader's own initial stabilities from their review log. */
export function fitSchedule(logs: ReviewLog[], now = Date.now()): ScheduleFit {
  const outcomes = firstOutcomes(logs);
  const stability = [...DEFAULT_INITIAL_STABILITY] as ScheduleFit['stability'];
  const samples: ScheduleFit['samples'] = [0, 0, 0, 0];
  for (const rating of [1, 2, 3, 4] as const) {
    const mine = outcomes.filter((o) => o.rating === rating);
    samples[rating - 1] = mine.length;
    if (mine.length < MIN_SAMPLES) continue;
    const fallback = DEFAULT_INITIAL_STABILITY[rating - 1];
    // Never further than fourfold from the default: beyond that it is more likely odd data than an odd memory.
    stability[rating - 1] = Math.min(fallback * 4, Math.max(fallback / 4, fitOne(mine, fallback)));
  }
  // A better first answer never means a shorter first interval.
  for (let i = 1; i < 4; i++) stability[i] = Math.max(stability[i], stability[i - 1]);
  return { stability: stability.map((s) => Math.round(s * 100) / 100) as ScheduleFit['stability'], samples, fittedAt: now };
}

export function storedFit(): ScheduleFit | null {
  try {
    const fit = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as ScheduleFit | null;
    return fit && Array.isArray(fit.stability) && fit.stability.length === 4 ? fit : null;
  } catch {
    return null;
  }
}

/** Puts the reader's own values to use, or the published defaults when personal fitting is off. */
export function applyFit(fit: ScheduleFit | null, personal: boolean): void {
  setInitialStability(personal && fit ? fit.stability : null);
}

/** Fits again from the whole log, remembers the result and applies it. */
export async function refitSchedule(personal: boolean): Promise<ScheduleFit> {
  const fit = fitSchedule(await db.reviews.toArray());
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(fit));
  } catch {
    // Fitted again next time.
  }
  applyFit(fit, personal);
  return fit;
}
