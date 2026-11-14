// Spaced-repetition scheduler: FSRS-5 (Free Spaced Repetition Scheduler).
//
// The model behind it describes a memory with three numbers — Difficulty, Stability and
// Retrievability (DSR). Stability is the number of days after which the chance of recalling the
// card has dropped to 90%; every review moves it, by more the closer the card was to being
// forgotten. The next review is placed where the predicted recall equals the retention the
// learner asked for, which is where a review does the most good (the spacing effect).
//
// Formulas and default parameters are those published by the authors:
//   J. Ye, J. Su, Y. Cao. A Stochastic Shortest Path Algorithm for Optimizing Spaced Repetition
//   Scheduling. KDD 2022.  —  https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm
// The parameters are the published defaults, fitted by the authors on a large set of real reviews.

export type Rating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy
export type CardState = 'new' | 'learning' | 'review' | 'relearning';

/** The scheduling half of a card. Times are epoch milliseconds. */
export interface Schedule {
  state: CardState;
  due: number;
  /** Days until recall probability falls to 90%. 0 for a card never reviewed. */
  stability: number;
  /** 1 (easy) … 10 (hard). */
  difficulty: number;
  reps: number;
  lapses: number;
  lastReview?: number;
  /** The interval the last review asked for, in days. */
  scheduledDays: number;
}

export const DAY = 86_400_000;
const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5;
const FACTOR = 19 / 81; // makes R(S, S) = 0.9
const MAX_INTERVAL = 36_500;
/** A forgotten card comes back within the same session. */
const RELEARN_DELAY = 60_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Probability of recalling a card `elapsedDays` after its last review. */
export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);
}

/** Days until recall probability falls to `retention`. */
export function intervalFor(stability: number, retention: number): number {
  const days = (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return clamp(Math.round(days), 1, MAX_INTERVAL);
}

/** Days a new card lasts after its first answer (again, hard, good, easy), as published. */
export const DEFAULT_INITIAL_STABILITY: readonly [number, number, number, number] = [W[0], W[1], W[2], W[3]];
let firstStability: readonly number[] = DEFAULT_INITIAL_STABILITY;

/** Replaces the initial stabilities with ones fitted to the reader (see fsrs-fit.ts); `null` restores the defaults. */
export function setInitialStability(values: readonly number[] | null): void {
  firstStability = values && values.length === 4 && values.every((v) => Number.isFinite(v) && v > 0) ? values : DEFAULT_INITIAL_STABILITY;
}

const initialStability = (g: Rating) => Math.max(0.1, firstStability[g - 1]);
const initialDifficulty = (g: Rating) => clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10);

function nextDifficulty(d: number, g: Rating): number {
  // The change shrinks as difficulty approaches 10 (linear damping), then drifts back towards
  // the difficulty of an "Easy" first answer, so a card cannot get stuck at the hard end.
  const damped = d + (-W[6] * (g - 3) * (10 - d)) / 9;
  return clamp(W[7] * initialDifficulty(4) + (1 - W[7]) * damped, 1, 10);
}

function stabilityAfterRecall(d: number, s: number, r: number, g: Rating): number {
  const hard = g === 2 ? W[15] : 1;
  const easy = g === 4 ? W[16] : 1;
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy);
}

function stabilityAfterLapse(d: number, s: number, r: number): number {
  const next = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
  // Forgetting never makes a memory stronger than it was.
  return clamp(next, 0.1, s);
}

/** A second review on the same day: a smaller, separate update. */
const stabilityShortTerm = (s: number, g: Rating) => Math.max(0.1, s * Math.exp(W[17] * (g - 3 + W[18])));

const startOfDay = (time: number) => {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function newSchedule(now: number): Schedule {
  return { state: 'new', due: now, stability: 0, difficulty: 0, reps: 0, lapses: 0, scheduledDays: 0 };
}

/** The card after being answered with `rating` at `now`. */
export function review(card: Schedule, rating: Rating, now: number, retention = 0.9): Schedule {
  let stability: number;
  let difficulty: number;
  if (card.state === 'new' || card.stability <= 0 || card.lastReview === undefined) {
    stability = initialStability(rating);
    difficulty = initialDifficulty(rating);
  } else {
    const elapsed = Math.max(0, (now - card.lastReview) / DAY);
    difficulty = nextDifficulty(card.difficulty, rating);
    if (Math.floor(elapsed) === 0) {
      stability = stabilityShortTerm(card.stability, rating);
    } else {
      const r = retrievability(elapsed, card.stability);
      stability = rating === 1 ? stabilityAfterLapse(card.difficulty, card.stability, r) : stabilityAfterRecall(card.difficulty, card.stability, r, rating);
    }
  }

  const base = { stability, difficulty, reps: card.reps + 1, lastReview: now };
  if (rating === 1) {
    const lapsed = card.state === 'review';
    return { ...base, state: card.state === 'review' || card.state === 'relearning' ? 'relearning' : 'learning', due: now + RELEARN_DELAY, lapses: card.lapses + (lapsed ? 1 : 0), scheduledDays: 0 };
  }
  const days = intervalFor(stability, retention);
  // Due from the start of that day: a card reviewed in the evening is not "late" the next morning.
  return { ...base, state: 'review', due: startOfDay(now) + days * DAY, lapses: card.lapses, scheduledDays: days };
}

/** What each answer would do, for the labels on the answer buttons. */
export function preview(card: Schedule, now: number, retention = 0.9): Record<Rating, Schedule> {
  return { 1: review(card, 1, now, retention), 2: review(card, 2, now, retention), 3: review(card, 3, now, retention), 4: review(card, 4, now, retention) };
}

/** "<1 хв", "3 д", "2 міс", "1,4 р" — the wait until a card comes back. */
export function intervalLabel(next: Schedule): string {
  if (next.scheduledDays === 0) return '< 1 хв';
  const d = next.scheduledDays;
  if (d < 30) return `${d} д`;
  if (d < 365) return `${Math.round(d / 30.4)} міс`;
  return `${(d / 365).toFixed(1).replace('.', ',')} р`;
}
