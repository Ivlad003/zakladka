import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'sepia' | 'dark';
export type ZoomMode = 'fit-width' | 'fit-page' | number;
export type EpubFont = 'publisher' | 'serif' | 'sans' | 'custom';
export type EpubFlow = 'paginated' | 'scrolled';
/** PDF/DjVu: one page at a time (turned by swiping) or one continuous scroll. */
export type FixedFlow = 'paged' | 'scrolled';
/** Extra buttons the floating page-turning control can carry besides back and forward. */
export type TurnExtra = 'menu' | 'bookmark' | 'toc' | 'ai';
export type AiLanguage = 'uk' | 'en' | 'auto';
export type AiProviderId = 'anthropic' | 'openrouter' | 'local' | 'browser';
/** Where the agents' web search goes. */
/** An agent the reader wrote themselves (Advanced AI settings). */
export interface CustomAgentDef {
  id: string;
  name: string;
  description: string;
  role: string;
  /** Inside a book, in the library, or in both. */
  where: 'book' | 'library' | 'both';
}

export type LibrarySort = 'recent' | 'title' | 'author' | 'progress' | 'added';
export type WebSearch = 'off' | 'auto' | 'wikipedia' | 'searxng';
/** How much book text a model can take in one go; local models are often run with small contexts. */
export type ContextSize = 'small' | 'medium' | 'large';
export type EmbedBackend = 'browser' | 'server';

export interface Settings {
  theme: Theme;
  epubFontSize: number;
  epubFont: EpubFont;
  epubLineHeight: number;
  epubFlow: EpubFlow;
  fixedZoom: ZoomMode;
  fixedFlow: FixedFlow;
  /** Ways of turning pages; any combination. */
  turnSwipe: boolean;
  /** Two fingers moved sideways together turn the page (where one finger is taken by the browser or by panning). */
  turnSwipe2: boolean;
  turnTap: boolean;
  /** A small floating group of buttons that can be dragged anywhere. */
  turnButtons: boolean;
  /** A bar under the page and a strip along each side that take swipes on behalf of the page. */
  turnZone: boolean;
  turnButtonsSize: 'small' | 'medium' | 'large';
  turnButtonsVertical: boolean;
  turnButtonsExtra: TurnExtra[];
  /** Centre of the floating buttons as fractions of the screen; null = the default corner. */
  turnButtonsPos: { x: number; y: number } | null;
  /** Shows what the touch handling sees, to find out why a gesture does nothing. */
  gestureDebug: boolean;
  /** Invert page images of PDF/DjVu in the dark theme. */
  invertInDark: boolean;
  aiProvider: AiProviderId;
  /** Claude API. */
  apiKey: string;
  model: string;
  /** Optional address of a gateway or proxy that speaks the Claude API; empty = api.anthropic.com. */
  anthropicBaseUrl: string;
  /** OpenRouter (or any other OpenAI-compatible cloud service). */
  openrouterBaseUrl: string;
  openrouterKey: string;
  openrouterModel: string;
  openrouterTools: boolean;
  openrouterVision: boolean;
  /** A local OpenAI-compatible server: Ollama, LM Studio, llama.cpp… */
  localBaseUrl: string;
  localModel: string;
  localApiKey: string;
  localTools: boolean;
  localVision: boolean;
  localContext: ContextSize;
  aiLanguage: AiLanguage;
  /** A model that runs in this browser on the device's own GPU (WebGPU); nothing leaves the device. */
  browserModel: string;
  /** Language of voice typing as a BCP 47 tag ("uk-UA"); empty = follow the reply language. */
  voiceLang: string;
  /** Which generation of defaults the stored settings were written under (see `load`). */
  rev: number;
  /** Typography of reflowable books (EPUB, FB2, MOBI, the text mode of PDF/DjVu). */
  epubMargins: 'narrow' | 'normal' | 'wide';
  epubAlign: 'publisher' | 'left' | 'justify';
  epubHyphens: boolean;
  /** Extra space between letters, in em. */
  epubLetterSpacing: number;
  epubParagraphGap: 'publisher' | 'none' | 'small' | 'large';
  /** Name of the font the reader added (the file itself is kept in the database). */
  epubCustomFontName: string;
  /** Two pages side by side: on wide screens, also on landscape tablets, or never. */
  spread: 'auto' | 'landscape' | 'off';
  /** Statistics: books to read this year, minutes a day. */
  yearGoal: number;
  dailyGoal: number;
  /** Advanced: agent instructions as the reader edited them (agent id → role), the shared style, extra instructions, own agents. */
  promptRoles: Record<string, string>;
  promptStyle: string;
  promptExtra: string;
  customAgents: CustomAgentDef[];
  /** Fit the first intervals of new cards to the reader's own answers. */
  studyPersonal: boolean;
  librarySort: LibrarySort;
  /** Reading aloud: speed, the chosen voice per language, and the language (empty: told from the text). */
  aloudRate: number;
  aloudVoices: Record<string, string>;
  aloudLang: string;
  /**
   * iPhone: ask for the "playback" audio session so the voice sounds with the silent switch on.
   * Off by default: on some iPhones this session silences Web Speech altogether.
   */
  aloudLoud: boolean;
  webSearch: WebSearch;
  /** Address of a SearXNG instance (or of a proxy to one) for `webSearch: 'searxng'`. */
  searxngUrl: string;
  /** Where text embeddings for semantic search are computed. */
  embedBackend: EmbedBackend;
  embedBaseUrl: string;
  embedModel: string;
  embedApiKey: string;
  /** Hugging Face id of the model used when embeddings are computed in the browser. */
  embedBrowserModel: string;
  /** Tesseract language codes used for OCR. */
  ocrLangs: string[];
  /** Cross-device sync through S3-compatible storage (RustFS, MinIO, …). */
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Prefix: string;
  syncAuto: boolean;
  /** Study: the chance of recalling a card that reviews are scheduled for (0.7–0.97). */
  studyRetention: number;
  /** Study: how many new cards may be started per day. */
  studyNewPerDay: number;
  /** A GitHub token for private repositories and a higher request limit; kept on this device only. */
  githubToken: string;
  /** Books made from a repository: the choices of the last one, offered again next time. */
  repoBookKind: 'book' | 'magazine' | 'article' | 'plain';
  repoBookSize: 'short' | 'medium' | 'long';
  /** Language the book is written in (a BCP 47 tag from the list in lib/repo-book). */
  repoBookLang: string;
}

export const MODELS: { id: string; name: string; hint: string }[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', hint: 'найкращий баланс якості та ціни' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', hint: 'швидше й дешевше' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', hint: 'найшвидша й найдешевша' },
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', hint: 'найпотужніша, найдорожча' },
];

const KEY = 'zakladka:settings';

const defaults: Settings = {
  theme: 'light',
  epubFontSize: 110,
  epubFont: 'publisher',
  epubLineHeight: 1.6,
  epubFlow: 'paginated',
  fixedZoom: 'fit-width',
  // Phones and tablets turn pages like a book; with a mouse a continuous scroll is handier.
  fixedFlow: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 'paged' : 'scrolled',
  turnSwipe: true,
  turnSwipe2: true,
  turnTap: true,
  // On by default where there is no keyboard: buttons work even where a browser swallows gestures.
  turnButtons: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
  turnZone: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
  turnButtonsSize: 'medium',
  turnButtonsVertical: false,
  turnButtonsExtra: ['menu'],
  turnButtonsPos: null,
  gestureDebug: false,
  invertInDark: true,
  aiProvider: 'anthropic',
  apiKey: '',
  model: 'claude-opus-5-5',
  anthropicBaseUrl: '',
  openrouterBaseUrl: 'https://openrouter.ai/api/v1',
  openrouterKey: '',
  openrouterModel: '',
  openrouterTools: true,
  openrouterVision: false,
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: '',
  localApiKey: '',
  localTools: true,
  localVision: false,
  localContext: 'medium',
  aiLanguage: 'uk',
  browserModel: '',
  voiceLang: '',
  rev: 2,
  epubMargins: 'normal',
  epubAlign: 'publisher',
  epubHyphens: false,
  epubLetterSpacing: 0,
  epubParagraphGap: 'publisher',
  epubCustomFontName: '',
  spread: 'auto',
  yearGoal: 12,
  dailyGoal: 20,
  promptRoles: {},
  promptStyle: '',
  promptExtra: '',
  customAgents: [],
  studyPersonal: true,
  librarySort: 'recent',
  aloudRate: 1,
  aloudVoices: {},
  aloudLang: '',
  aloudLoud: false,
  // "auto": through the app's own server when there is one (a real web search), otherwise Wikipedia.
  webSearch: 'auto',
  searxngUrl: '',
  embedBackend: 'browser',
  embedBaseUrl: 'http://localhost:11434/v1',
  embedModel: 'bge-m3',
  embedApiKey: '',
  embedBrowserModel: 'Xenova/multilingual-e5-small',
  ocrLangs: ['ukr', 'eng'],
  s3Endpoint: '',
  s3Region: 'us-east-1',
  s3Bucket: 'zakladka',
  s3AccessKey: '',
  s3SecretKey: '',
  s3Prefix: '',
  syncAuto: true,
  studyRetention: 0.9,
  studyNewPerDay: 15,
  githubToken: '',
  repoBookKind: 'book',
  repoBookSize: 'medium',
  repoBookLang: 'uk',
};

export const LOCAL_PRESETS: { name: string; url: string }[] = [
  { name: 'Ollama', url: 'http://localhost:11434/v1' },
  { name: 'LM Studio', url: 'http://localhost:1234/v1' },
  { name: 'llama.cpp', url: 'http://localhost:8080/v1' },
];

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Settings>;
      // Rev 2: "auto" replaced Wikipedia as the default way to look things up on the web.
      if ((stored.rev ?? 1) < 2 && stored.webSearch === 'wikipedia') stored.webSearch = 'auto';
      return { ...defaults, ...stored, rev: 2 };
    }
  } catch {
    // Storage can be unavailable (private mode) — fall back to defaults.
  }
  return defaults;
}

let state: Settings = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return state;
}

export function updateSettings(patch: Partial<Settings>): void {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Ignore: settings then live only for this session.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings);
}

export const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#ffd84d',
  green: '#7ddc8a',
  blue: '#7db8ff',
  pink: '#ff9ebb',
};

/** Colours used inside EPUB content for each theme. */
export const READING_PALETTE: Record<Theme, { bg: string; fg: string; link: string }> = {
  light: { bg: '#ffffff', fg: '#1f2328', link: '#2b5ea7' },
  sepia: { bg: '#f6ecd6', fg: '#3d2f1f', link: '#8a4b12' },
  dark: { bg: '#1a1c21', fg: '#d6d8dd', link: '#8fb4f5' },
};
