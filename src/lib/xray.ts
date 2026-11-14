// X-Ray: the people, places and names a book keeps coming back to, and where in the book each one
// appears — the way Kindle shows it.
//
// Names are found without any AI: words written with a capital letter in the middle of a sentence,
// on their own or in runs ("Шерлок Голмс"), that the book uses again and again and seldom writes in
// lower case (which would make them ordinary words). A short description of any of them can then be
// asked of the AI, from passages up to where the reader is, so that it gives nothing away.
import { db } from '../db';
import type { Engine } from '../engines/types';

export const XRAY_VERSION = 2;

/** How much of the start and end of a page counts as its head and foot. */
const EDGE = 140;

export interface XrayTerm {
  name: string;
  count: number;
  /** Mentions per unit (page or section), as [unit, count] pairs. */
  units: [number, number][];
}

export interface XrayIndex {
  terms: XrayTerm[];
  unitCount: number;
}

/** Capitalised words that start sentences or name nothing in particular. */
const COMMON = new Set(
  'Я Ти Він Вона Воно Ми Ви Вони Це Цей Ця Ці Той Та Ті Що Як Де Коли Чому Хто Але Та І Й А Або Чи Не Ні Так Ось Там Тут Його Її Їх Мене Тебе Нас Вас Мій Моя Твій Наш Ваш Отже Бо Адже Проте Також Тоді Потім Вже Ще Навіть Лише Тільки Усе Все Всі Усі Кожен Пан Пані Розділ Глава Частина Книга Сторінка Он Она Оно Они Мы Вы Это Этот Эта Эти Тот Как Где Когда Почему Кто Но Или Да Нет Вот Его Ее Её Их Меня Тебя Нас Вас Мой Моя Твой Наш Ваш Итак Ведь Однако Тоже Также Тогда Потом Уже Еще Ещё Даже Лишь Только Все Всё Каждый Господин Госпожа Глава Часть Книга Раздел Страница The A An I He She It We You They This That These Those What How Where When Why Who But And Or Not No Yes So Then Here There His Her Their My Your Our Mr Mrs Ms Dr Sir Chapter Part Book Page'.split(
    ' ',
  ),
);

/** Marks a run that began a sentence, kept apart until it is known whether the book writes it mid-sentence too. */
const START = '\u0001';

const isCapital = (w: string) => /^[\p{Lu}][\p{Ll}'’ʼ-]+$/u.test(w);

/**
 * Names in one unit's text, with how often each occurs there; also counts words written in lower
 * case, and single words followed by a number ("Figure 3", "Таблиця 2" are labels, not names).
 */
function namesIn(text: string, lower: Map<string, number>, numbered: Map<string, number>): Map<string, number> {
  const found = new Map<string, number>();
  for (const w of text.match(/(?<![\p{L}])[\p{Ll}][\p{Ll}'’ʼ-]+/gu) ?? []) lower.set(w, (lower.get(w) ?? 0) + 1);
  for (const sentence of text.split(/(?<=[.!?…])[»"”]?\s+|\n+/)) {
    const words = [...sentence.matchAll(/[\p{L}][\p{L}'’ʼ-]*/gu)].map((m) => ({ w: m[0], at: m.index ?? 0 }));
    const name = (k: number) => isCapital(words[k].w) && !COMMON.has(words[k].w);
    // Two words belong to one name only when nothing but spaces stands between them.
    const joined = (k: number) => /^\s+$/.test(sentence.slice(words[k].at + words[k].w.length, words[k + 1].at));
    for (let i = 0; i < words.length; ) {
      if (!name(i)) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < words.length && j - i < 4 && name(j) && joined(j - 1)) j++;
      // The first word of a sentence has its capital anyway ("Над Лондоном", "Тоді Ватсон"): what
      // follows it is a name; the whole run counts only if the book also writes it mid-sentence.
      const first = i === 0 || /[«"“(—–-]\s*$/.test(sentence.slice(0, words[i].at));
      const key = (from: number) => words.slice(from, j).map((x) => x.w).join(' ');
      if (j === i + 1 && /^\s*\d/.test(sentence.slice(words[i].at + words[i].w.length))) numbered.set(words[i].w, (numbered.get(words[i].w) ?? 0) + 1);
      if (!first) found.set(key(i), (found.get(key(i)) ?? 0) + 1);
      else if (j - i >= 2) {
        found.set(key(i + 1), (found.get(key(i + 1)) ?? 0) + 1);
        const whole = `${START}${key(i)}`;
        found.set(whole, (found.get(whole) ?? 0) + 1);
      }
      i = j;
    }
  }
  return found;
}

/** Builds the X-Ray of a book from its text. */
export async function buildXray(engine: Engine, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<XrayIndex> {
  const total = engine.unitCount;
  const perUnit: Map<string, number>[] = [];
  /** Names at the very top or bottom of each unit: where running heads and footers stand. */
  const atEdges: Map<string, number>[] = [];
  const lower = new Map<string, number>();
  const numbered = new Map<string, number>();
  const ignore = new Map<string, number>();
  for (let i = 0; i < total; i++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const text = await engine.getUnitText(i).catch(() => '');
    perUnit.push(namesIn(text, lower, numbered));
    const edges = namesIn(text.slice(0, EDGE), ignore, ignore);
    for (const [name, n] of namesIn(text.slice(-EDGE), ignore, ignore)) edges.set(name, (edges.get(name) ?? 0) + n);
    atEdges.push(edges);
    if (i % 5 === 4 || i === total - 1) {
      onProgress(i + 1, total);
      await new Promise((done) => setTimeout(done, 0));
    }
  }
  const totals = new Map<string, number>();
  for (const unit of perUnit) for (const [name, n] of unit) if (!name.startsWith(START)) totals.set(name, (totals.get(name) ?? 0) + n);
  // Runs that began a sentence join a name the book also writes mid-sentence ("Шерлок Голмс").
  for (const unit of perUnit) {
    for (const [name, n] of [...unit]) {
      if (!name.startsWith(START)) continue;
      unit.delete(name);
      const real = name.slice(1);
      if (!totals.has(real)) continue;
      totals.set(real, totals.get(real)! + n);
      unit.set(real, (unit.get(real) ?? 0) + n);
    }
  }
  // A single word found inside a longer name of the same person ("Голмс" in "Шерлок Голмс") stays its own entry: books use both.
  const least = total < 20 ? 2 : 3;
  const terms: XrayTerm[] = [];
  for (const [name, count] of totals) {
    if (count < least) continue;
    const single = !name.includes(' ');
    // Written in lower case about as often: an ordinary word, not a name.
    if (single && (lower.get(name.toLocaleLowerCase()) ?? 0) >= count * 0.5) continue;
    // Mostly followed by a number: a label ("Figure 10", "Розділ 3").
    if (single && (numbered.get(name) ?? 0) >= count * 0.5) continue;
    const units: [number, number][] = [];
    let edge = 0;
    perUnit.forEach((m, i) => {
      const n = m.get(name);
      if (!n) return;
      units.push([i, n]);
      edge += Math.min(n, atEdges[i].get(name) ?? 0);
    });
    // On a good share of the pages and nearly always at their top or bottom: a running head
    // ("Release Copy · Page 3 of 71", the book's title over every page), not something the book is about.
    if (total >= 6 && units.length >= Math.max(3, total * 0.3) && edge >= count * 0.7) continue;
    terms.push({ name, count, units });
  }
  terms.sort((a, b) => b.count - a.count);
  return { terms: terms.slice(0, 150), unitCount: total };
}

export async function storedXray(bookId: string): Promise<XrayIndex | null> {
  const kept = await db.xray.get(bookId);
  return kept && kept.version === XRAY_VERSION ? { terms: kept.terms, unitCount: kept.unitCount } : null;
}

export async function saveXray(bookId: string, index: XrayIndex): Promise<void> {
  const kept = await db.xray.get(bookId);
  await db.xray.put({ bookId, version: XRAY_VERSION, terms: index.terms, unitCount: index.unitCount, notes: kept?.notes ?? {}, builtAt: Date.now() });
}

/** Up to `limit` short passages around the term, from units at or before `upTo` (no spoilers). */
export async function passagesAbout(engine: Engine, term: XrayTerm, upTo: number, limit = 6): Promise<{ unit: number; text: string }[]> {
  const out: { unit: number; text: string }[] = [];
  for (const [unit] of term.units) {
    if (unit > upTo || out.length >= limit) break;
    const text = (await engine.getUnitText(unit).catch(() => '')).replace(/\s+/g, ' ');
    let from = 0;
    while (out.length < limit) {
      const at = text.indexOf(term.name, from);
      if (at < 0) break;
      out.push({ unit, text: text.slice(Math.max(0, at - 160), at + term.name.length + 200).trim() });
      from = at + term.name.length + 400;
    }
  }
  return out;
}

export async function saveXrayNote(bookId: string, name: string, note: string): Promise<void> {
  const kept = await db.xray.get(bookId);
  if (!kept) return;
  await db.xray.update(bookId, { notes: { ...kept.notes, [name]: note } });
}
