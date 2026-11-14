// Reading the book aloud with the voices the device has (the Web Speech API). Nothing is sent
// anywhere unless the reader picks one of the browser's online voices.
//
// The book is read a page at a time, as it is on screen: when the text of the page has been spoken
// the page is turned and the next one read. A sentence cut by a page break is finished together
// with the next page, so the voice does not stumble at every turn.
import { useSyncExternalStore } from 'react';

export interface AloudSource {
  /** Identifies the page on screen; when it changes without us turning, the reader has moved. */
  pageKey(): string;
  /** Text of the page on screen. */
  pageText(): Promise<string>;
  /** Turns to the next page; false at the end of the book. */
  nextPage(): Promise<boolean>;
}

export interface AloudState {
  status: 'idle' | 'playing' | 'paused';
  /** What is being spoken right now. */
  sentence: string;
  /** Two-letter code of the language being spoken. */
  lang: string;
  /** Something the reader should know: no voice for the language, no text on the pages, the end. */
  note: string | null;
}

export interface AloudOptions {
  rate: number;
  /** Chosen voice (its `voiceURI`) per language; empty means the device's default for the language. */
  voices: Record<string, string>;
  /** Two-letter code, or empty to tell from the text. */
  lang: string;
}

export const aloudSupported = (): boolean => typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';

let state: AloudState = { status: 'idle', sentence: '', lang: '', note: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<AloudState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useAloud = (): AloudState => useSyncExternalStore(subscribe, () => state);
export const aloudState = (): AloudState => state;

let options: AloudOptions = { rate: 1, voices: {}, lang: '' };
let source: AloudSource | null = null;
/** Bumped to abandon whatever is running: a stop, a pause, a new start. */
let run = 0;
/** The unfinished sentence at the bottom of the previous page. */
let carry = '';
/** Where a pause happened: the chunks of the page and the one to say again. */
let paused: { key: string; chunks: string[]; at: number } | null = null;
// Chrome drops an utterance nobody holds on to before it has finished.
let speaking: SpeechSynthesisUtterance | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
/** Whether any utterance of this run has started; until one does, the voice may be blocked or muted. */
let heard = false;
/** The page on screen read ahead, so that a tap can start speaking at once (see startAloud). */
let prepared: { key: string; chunks: string[]; carry: string; lang: string } | null = null;

export const isIos = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const SILENT_NOTE = isIos()
  ? 'Не чути голосу? Вимкніть беззвучний режим (перемикач збоку iPhone) і додайте гучності. Якщо не допоможе — завантажте голос: Параметри → Універсальний доступ → Вміст мовлення → Голоси.'
  : 'Пристрій не почав читати. Перевірте гучність і чи є в системі голос для цієї мови.';

/** Half a second of silence as a WAV file, for waking the audio up inside a tap. */
const SILENCE = (() => {
  const samples = 4000;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return `data:audio/wav;base64,${btoa(binary)}`;
})();

/**
 * Inside the tap: asks for the playback audio session (Safari 16.4+: sound even with the silent
 * switch on, where the system allows it) and plays a moment of silence, which wakes the audio on iOS.
 */
function wakeAudio(): void {
  try {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
  } catch {
    // Not every browser lets this be set.
  }
  try {
    const audio = new Audio(SILENCE);
    audio.setAttribute('playsinline', '');
    void audio.play().catch(() => {});
  } catch {
    // Without it speech may still work.
  }
}

/** Reads the page on screen ahead of a tap on ▶, so that the tap itself can start the voice. */
export async function prepareAloud(from: AloudSource, opts: Pick<AloudOptions, 'lang'>): Promise<void> {
  if (state.status !== 'idle') return;
  const key = from.pageKey();
  if (prepared?.key === key) return;
  const text = tidy(await from.pageText());
  if (state.status !== 'idle' || from.pageKey() !== key) return;
  const { whole, rest } = cutAtSentence(text);
  prepared = { key, chunks: toChunks(whole), carry: rest, lang: opts.lang || guessLang(text) };
}

// ---- Text ----
/** Which language a text is in, as far as picking a voice needs to know. */
export function guessLang(text: string): string {
  const sample = text.slice(0, 3000);
  const cyrillic = (sample.match(/[Ѐ-ӿ]/g) ?? []).length;
  const latin = (sample.match(/[a-z]/gi) ?? []).length;
  if (cyrillic > latin) {
    if (/[іїєґ]/i.test(sample)) return 'uk';
    return /[ыэъё]/i.test(sample) ? 'ru' : 'uk';
  }
  if (/[ąćęłńśźż]/i.test(sample)) return 'pl';
  if (/[äöüß]/i.test(sample)) return 'de';
  if (/[àâçèéêëîïôùûœ]/i.test(sample) && /\b(le|la|les|des|une|est)\b/i.test(sample)) return 'fr';
  if (/[ñ¿¡]/i.test(sample)) return 'es';
  return 'en';
}

/** Page text as it should be spoken: words split by a line break are joined, line ends are spaces. */
const tidy = (text: string) =>
  text
    .replace(/([\p{L}])[-­]\s*\n\s*(?=\p{Ll})/gu, '$1')
    .replace(/­/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const SENTENCE = /[^.!?…]+(?:[.!?…]+["»”’')\]]*|$)/g;

/** Splits text into pieces short enough for every speech engine to say without cutting off. */
export function toChunks(text: string, max = 200): string[] {
  const out: string[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer.trim()) out.push(buffer.trim());
    buffer = '';
  };
  for (const raw of text.match(SENTENCE) ?? []) {
    let sentence = raw.trim();
    if (!sentence) continue;
    // A very long sentence is cut at commas, then at spaces.
    while (sentence.length > max * 1.6) {
      const window = sentence.slice(0, max * 1.6);
      const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' — '));
      const at = cut > max * 0.4 ? cut + 1 : window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : window.length;
      flush();
      out.push(sentence.slice(0, at).trim());
      sentence = sentence.slice(at).trim();
    }
    if (buffer && buffer.length + sentence.length + 1 > max) flush();
    buffer = buffer ? `${buffer} ${sentence}` : sentence;
  }
  flush();
  return out;
}

/** The text up to its last complete sentence, and the unfinished rest (kept for the next page). */
export function cutAtSentence(text: string): { whole: string; rest: string } {
  const m = /^[\s\S]*[.!?…]["»”’')\]]*(?=\s|$)/.exec(text);
  if (!m) return { whole: text, rest: '' };
  const rest = text.slice(m[0].length).trim();
  // A long tail without a full stop is more likely a list or a table than half a sentence.
  return rest.length > 400 ? { whole: text, rest: '' } : { whole: m[0].trim(), rest };
}

// ---- Voices ----
const LANG_TAG: Record<string, string> = { uk: 'uk-UA', en: 'en-US', ru: 'ru-RU', pl: 'pl-PL', de: 'de-DE', fr: 'fr-FR', es: 'es-ES' };

/** The device's voices for a language, the built-in ones first. */
export function voicesFor(lang: string): SpeechSynthesisVoice[] {
  if (!aloudSupported()) return [];
  return speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang))
    .sort((a, b) => Number(b.localService) - Number(a.localService) || Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
}

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const mine = voicesFor(lang);
  return mine.find((v) => v.voiceURI === options.voices[lang]) ?? mine[0] ?? null;
}

// ---- Speaking ----
function say(text: string, token: number): Promise<void> {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(state.lang);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang ?? LANG_TAG[state.lang] ?? state.lang;
    utterance.rate = options.rate;
    // Some engines never report the end of an utterance; nothing waits on one for ever.
    const limit = setTimeout(done, 20_000 + text.length * 250);
    function done() {
      clearTimeout(limit);
      if (speaking === utterance) speaking = null;
      resolve();
    }
    utterance.onend = done;
    utterance.onerror = (e) => {
      // "not-allowed": the page may not speak — on iOS, speech has to begin in a tap.
      if ((e as SpeechSynthesisErrorEvent).error === 'not-allowed' && token === run) set({ note: SILENT_NOTE });
      done();
    };
    utterance.onstart = () => {
      heard = true;
    };
    speaking = utterance;
    if (token === run) {
      speechSynthesis.speak(utterance);
      // Nothing started after a while: the device is not speaking, and the reader should know why.
      if (!heard) setTimeout(() => !heard && token === run && speaking === utterance && set({ note: SILENT_NOTE }), 4000);
    } else done();
  });
}

async function holdScreen(on: boolean): Promise<void> {
  try {
    if (!on) {
      await wakeLock?.release();
      wakeLock = null;
    } else if (!wakeLock && 'wakeLock' in navigator) {
      wakeLock = await (navigator as unknown as { wakeLock: { request(kind: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock.request('screen');
    }
  } catch {
    // The screen may dim; reading goes on while the page is visible.
  }
}

async function play(token: number, resume: typeof paused): Promise<void> {
  const from = source;
  if (!from) return;
  let emptyPages = 0;
  let pending = resume;
  for (;;) {
    let key = from.pageKey();
    let chunks: string[];
    let at = 0;
    if (pending && pending.key === key) {
      ({ chunks, at } = pending);
    } else {
      if (pending) carry = '';
      const text = tidy(await from.pageText());
      if (token !== run) return;
      key = from.pageKey();
      const joined = carry && text ? `${carry} ${text}` : carry || text;
      const { whole, rest } = cutAtSentence(joined);
      carry = rest;
      chunks = toChunks(whole);
      if (!state.lang && joined) {
        const lang = options.lang || guessLang(joined);
        set({ lang, note: pickVoice(lang) ? null : `На цьому пристрої немає голосу для мови «${lang}» — вимова може бути неправильною. Голоси додаються в налаштуваннях системи.` });
      }
    }
    pending = null;
    emptyPages = chunks.length ? 0 : emptyPages + 1;
    if (emptyPages >= 8) {
      stopAloud('На останніх сторінках немає тексту. Якщо це скан — спершу розпізнайте текст (OCR).');
      return;
    }
    for (let i = at; i < chunks.length; i++) {
      paused = { key, chunks, at: i };
      set({ sentence: chunks[i] });
      await say(chunks[i], token);
      if (token !== run) return;
      // The reader turned the page themselves: go on from what they are looking at.
      if (from.pageKey() !== key) {
        carry = '';
        break;
      }
    }
    paused = null;
    if (token !== run) return;
    if (from.pageKey() !== key) continue;
    const more = await from.nextPage();
    if (token !== run) return;
    if (!more) {
      if (carry) {
        const last = carry;
        carry = '';
        set({ sentence: last });
        await say(last, token);
        if (token !== run) return;
      }
      stopAloud('Книгу дочитано до кінця.');
      return;
    }
  }
}

/** Starts reading from the page on screen. Must be called from a tap: phones only let a page speak after one. */
export function startAloud(from: AloudSource, opts: AloudOptions): void {
  if (!aloudSupported()) return;
  run++;
  heard = false;
  wakeAudio();
  // Cancelling right before speaking can swallow the new utterance on iOS; only cancel what is there.
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
  source = from;
  options = opts;
  carry = '';
  paused = null;
  const ready = prepared && prepared.key === from.pageKey() && prepared.chunks.length ? prepared : null;
  prepared = null;
  set({ status: 'playing', sentence: '', lang: ready?.lang ?? opts.lang, note: null });
  void holdScreen(true);
  if (ready) {
    // iOS lets a page speak only from a tap, so the first sentence is spoken right here, synchronously.
    carry = ready.carry;
    void play(run, { key: ready.key, chunks: ready.chunks, at: 0 });
  } else {
    const unlock = new SpeechSynthesisUtterance(' ');
    unlock.volume = 0;
    speechSynthesis.speak(unlock);
    void play(run, null);
  }
}

export function pauseAloud(): void {
  if (state.status !== 'playing') return;
  run++;
  speechSynthesis.cancel();
  set({ status: 'paused' });
  void holdScreen(false);
}

export function resumeAloud(): void {
  if (state.status !== 'paused' || !source) return;
  run++;
  wakeAudio();
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
  set({ status: 'playing', note: null });
  void holdScreen(true);
  void play(run, paused);
}

export function stopAloud(note: string | null = null): void {
  run++;
  if (aloudSupported()) speechSynthesis.cancel();
  source = null;
  carry = '';
  paused = null;
  set({ status: 'idle', sentence: '', note });
  void holdScreen(false);
}

/** A new speed or voice applies from the next sentence; changing the language starts the sentence over. */
export function setAloudOptions(next: AloudOptions): void {
  const langChanged = next.lang !== options.lang && Boolean(next.lang);
  options = next;
  if (!langChanged || state.status === 'idle') return;
  set({ lang: next.lang, note: pickVoice(next.lang) ? null : `На цьому пристрої немає голосу для мови «${next.lang}».` });
  if (state.status === 'playing') {
    run++;
    speechSynthesis.cancel();
    void play(run, paused);
  }
}
