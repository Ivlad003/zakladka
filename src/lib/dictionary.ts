// Word lookup for the dictionary card: Wiktionary, in the reader's language for Ukrainian words and
// in English for English ones. Both answer browsers directly (CORS), so no server is needed; without
// a connection the card says so and offers the AI instead.
import { guessLang } from './read-aloud';
import { timeoutSignal } from './utils';

export interface Definition {
  word: string;
  /** The headword found, when it differs from the word looked up (a form of it). */
  lemma: string;
  lang: string;
  meanings: string[];
  /** Where to read the whole entry. */
  url: string;
  /** Set when the meanings are English glosses of a Ukrainian or Russian word (from the English Wiktionary). */
  glosses?: boolean;
}

const cache = new Map<string, Definition | null>();

/** A single word worth looking up: letters (with an apostrophe or a hyphen inside), not a whole phrase. */
export const isWord = (text: string): boolean => /^[\p{L}][\p{L}'’ʼ-]{0,29}$/u.test(text.trim());

interface EnEntry {
  meanings: string[];
  /** When every meaning only says which form of another word this is ("plural of keeper", "genitive singular of маяк"): that word. */
  formOf?: string;
}

/** A word's meanings in one language section of the English Wiktionary. */
async function enDefinitions(title: string, lang: string): Promise<EnEntry> {
  const res = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(title)}`, { signal: timeoutSignal(8000) });
  if (res.status === 404) return { meanings: [] };
  if (!res.ok) throw new Error(`Wiktionary answered ${res.status}`);
  const json = (await res.json()) as Record<string, { partOfSpeech: string; definitions: { definition: string }[] }[]>;
  const meanings: string[] = [];
  const targets: (string | null)[] = [];
  for (const e of json[lang] ?? []) {
    for (const d of e.definitions) {
      const doc = new DOMParser().parseFromString(d.definition, 'text/html');
      const text = doc.body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      if (text.length < 2) continue;
      meanings.push(`${e.partOfSpeech ? `(${e.partOfSpeech.toLowerCase()}) ` : ''}${text}`);
      // The word itself, without the transliteration beside it ("лінза (línza)") or stress marks.
      const link = doc.querySelector('.form-of-definition-link');
      const word = (link?.querySelector('.mention, i, a')?.textContent ?? link?.textContent ?? '').replace(/\s*\(.*$/, '').normalize('NFD').replace(/́/g, '').normalize('NFC').trim();
      targets.push(word || null);
    }
  }
  const formOf = targets.length && targets.every(Boolean) ? (targets[0] as string) : undefined;
  return { meanings, formOf: formOf !== title ? formOf : undefined };
}

/** A form's meanings, or those of the word it is a form of. */
async function enLookUp(titles: string[], lang: string): Promise<{ lemma: string; meanings: string[] } | null> {
  for (const title of titles) {
    const found = await enDefinitions(title, lang);
    if (!found.meanings.length) continue;
    if (found.formOf) {
      const base = await enDefinitions(found.formOf, lang);
      if (base.meanings.length) return { lemma: found.formOf, meanings: base.meanings };
    }
    return { lemma: title, meanings: found.meanings };
  }
  return null;
}

async function english(word: string): Promise<Definition | null> {
  const found = await enLookUp(word !== word.toLowerCase() ? [word, word.toLowerCase()] : [word], 'en');
  return found ? { word, lemma: found.lemma, lang: 'en', meanings: found.meanings.slice(0, 5), url: `https://en.wiktionary.org/wiki/${encodeURIComponent(found.lemma)}` } : null;
}

// (\b would not work here: for JavaScript, Cyrillic letters are not word characters.)
const SUBSECTIONS = /^(Синоніми|Антоніми|Гіпероніми|Гіпоніми|Холоніми|Мероніми|Згідно з|Переклад)(?![\p{L}])/iu;

/** The "Значення" section of a Ukrainian Wiktionary page, as separate meanings. */
async function ukrainianPage(title: string): Promise<string[] | null> {
  const params = new URLSearchParams({ action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki', redirects: '1', titles: title, format: 'json', origin: '*' });
  const res = await fetch(`https://uk.wiktionary.org/w/api.php?${params}`, { signal: timeoutSignal(8000) });
  if (!res.ok) throw new Error(`Wiktionary answered ${res.status}`);
  const json = (await res.json()) as { query?: { pages?: Record<string, { missing?: string; extract?: string }> } };
  const page = Object.values(json.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined || !page.extract) return null;
  const lines = page.extract.split('\n');
  const start = lines.findIndex((l) => /^=+\s*Значення\s*=+$/i.test(l.trim()));
  if (start < 0) return null;
  const meanings: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // The next heading, or the empty subsections that follow the meanings in plain text.
    if (/^=+.*=+$/.test(line.trim()) || SUBSECTIONS.test(line.trim())) break;
    const text = line.replace(/^[\s\d.)•-]+/, '').replace(/\s*◆.*$/, '').trim();
    if (text.length > 3 && !/^відсутній приклад/i.test(text)) meanings.push(text);
    if (meanings.length >= 5) break;
  }
  return meanings.length ? meanings : null;
}

/**
 * Dictionary forms a Ukrainian word may come from, likeliest first: a case or number ending taken off
 * a noun or adjective ("маяка" → "маяк", "капітанів" → "капітан"), or a verb form turned back into
 * the infinitive ("проводив" → "проводити", "підіймався" → "підійматися", "вказує" → "вказувати").
 */
function headwords(word: string): string[] {
  const w = word.toLocaleLowerCase();
  const out: string[] = [];
  const add = (stem: string, endings: string[]) => {
    if (stem.length < 3) return;
    for (const e of endings) if (stem + e !== w && !out.includes(stem + e)) out.push(stem + e);
  };
  const VERB: [string, string[]][] = [
    ['ується', ['уватися']], ['ує', ['увати']], ['ують', ['увати']], ['вався', ['ватися']], ['валася', ['ватися']], ['вся', ['тися']],
    ['лася', ['тися']], ['лося', ['тися']], ['лися', ['тися']], ['ться', ['тися']], ['в', ['ти']], ['ла', ['ти']], ['ло', ['ти']], ['ли', ['ти']],
  ];
  const NOUN = ['ями', 'ами', 'ові', 'еві', 'єві', 'ого', 'ому', 'ими', 'ях', 'ах', 'ям', 'ам', 'ою', 'ею', 'єю', 'ом', 'ем', 'ів', 'їв', 'ій', 'ий', 'их', 'им', 'ої', 'ую', 'юю', 'а', 'я', 'у', 'ю', 'і', 'ї', 'и', 'е', 'є', 'о'];
  const forms = [...VERB.map(([e, to]) => ({ e, to })), ...NOUN.map((e) => ({ e, to: ['', 'а', 'я', 'ь', 'о', 'и', 'ий'] }))];
  forms.sort((a, b) => b.e.length - a.e.length);
  for (const { e, to } of forms) if (w.endsWith(e)) add(w.slice(0, -e.length), to);
  return out.slice(0, 40);
}

/** Which of the titles have a page on that Wiktionary, in the order given. */
async function existing(titles: string[], site: 'uk' | 'en' = 'uk'): Promise<string[]> {
  if (!titles.length) return [];
  const params = new URLSearchParams({ action: 'query', titles: titles.join('|'), format: 'json', formatversion: '2', origin: '*' });
  const res = await fetch(`https://${site}.wiktionary.org/w/api.php?${params}`, { signal: timeoutSignal(8000) });
  // Busy or unreachable is not "no such word" (which would be remembered for the session).
  if (!res.ok) throw new Error(`Wiktionary answered ${res.status}`);
  const pages = ((await res.json()) as { query?: { pages?: { title: string; missing?: boolean }[] } }).query?.pages ?? [];
  const found = new Set(pages.filter((p) => !p.missing).map((p) => p.title));
  return titles.filter((t) => found.has(t));
}

const LANGUAGE_NAME: Record<string, string> = { uk: 'Ukrainian', ru: 'Russian', be: 'Belarusian', bg: 'Bulgarian', sr: 'Serbian' };

/** English glosses of a Cyrillic word from the English Wiktionary; a form ("genitive of маяк") is followed to its headword. */
async function englishGlosses(word: string, titles: string[], lang: string): Promise<Definition | null> {
  const found = await enLookUp((await existing(titles, 'en')).slice(0, 2), lang);
  if (!found) return null;
  return {
    word,
    lemma: found.lemma,
    lang,
    meanings: found.meanings.slice(0, 5),
    url: `https://en.wiktionary.org/wiki/${encodeURIComponent(found.lemma)}#${LANGUAGE_NAME[lang] ?? 'Ukrainian'}`,
    glosses: true,
  };
}

async function ukrainian(word: string, lang: string): Promise<Definition | null> {
  const url = (t: string) => `https://uk.wiktionary.org/wiki/${encodeURIComponent(t)}`;
  // The word as written, then its dictionary forms (an inflected form with the ending taken off),
  // all checked in one request so that a lookup costs Wikimedia two or three requests, not ten.
  const titles = [...new Set([word, word.toLocaleLowerCase(), ...headwords(word)])];
  for (const title of (await existing(titles)).slice(0, 2)) {
    const meanings = await ukrainianPage(title);
    if (meanings) return { word, lemma: title, lang: 'uk', meanings, url: url(title) };
  }
  // The Ukrainian Wiktionary lacks many everyday words ("капітан", "судно"); the English one has
  // most of them, explained in English.
  const glossed = await englishGlosses(word, titles.slice(1), lang);
  if (glossed) return glossed;
  // Otherwise the entries that list it in their tables are found by search.
  const params = new URLSearchParams({ action: 'query', list: 'search', srsearch: word, srlimit: '6', format: 'json', origin: '*' });
  const res = await fetch(`https://uk.wiktionary.org/w/api.php?${params}`, { signal: timeoutSignal(8000) });
  if (!res.ok) throw new Error(`Wiktionary answered ${res.status}`);
  const hits = ((await res.json()) as { query?: { search?: { title: string }[] } }).query?.search ?? [];
  const stem = word.toLocaleLowerCase().slice(0, Math.max(3, Math.min(5, word.length - 2)));
  // Proper names ("Маяки", "Капітанюк") only for a word written with a capital; a dictionary form
  // is seldom longer than the word read, so longer titles ("доглядачка" for "доглядач") come after.
  const capital = word[0] !== word[0].toLocaleLowerCase();
  const near = hits.filter((h) => h.title.toLocaleLowerCase().startsWith(stem) && !h.title.includes(' ') && (capital || h.title[0] === h.title[0].toLocaleLowerCase()));
  const rank = (t: string) => Number(t.length > word.length + 1) * 2 + Number(t[0] !== t[0].toLocaleLowerCase());
  near.sort((a, b) => rank(a.title) - rank(b.title));
  for (const hit of near.slice(0, 3)) {
    const meanings = await ukrainianPage(hit.title);
    if (meanings) return { word, lemma: hit.title, lang: 'uk', meanings, url: url(hit.title) };
  }
  return null;
}

/** Looks a word up. Resolves to null when the dictionary has no entry; throws when it cannot be reached. */
export async function lookUp(raw: string): Promise<Definition | null> {
  const word = raw.trim().replace(/^[«"'(]+|[»"'),.;:!?]+$/g, '');
  const key = word.toLocaleLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  const lang = /\p{Script=Cyrillic}/u.test(word) ? guessLang(word) : 'en';
  const found = lang === 'en' ? await english(word) : await ukrainian(word, lang);
  cache.set(key, found);
  return found;
}
