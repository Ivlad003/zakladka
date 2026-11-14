export type BookFormat = 'pdf' | 'epub' | 'djvu';

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  size: number;
  fileName: string;
  addedAt: number;
  lastOpenedAt: number;
  /** Reading progress, 0..1. */
  progress: number;
  /** Page index (as a string) for PDF/DjVu, CFI for EPUB. */
  position: string | null;
  /** Pages for PDF/DjVu, spine sections for EPUB. */
  unitCount: number;
  cover: Blob | null;
  /** When the reading position last changed; the newer position wins when devices sync. */
  positionAt?: number;
  /** Known from sync, but the file itself has not been downloaded to this device yet. */
  cloudOnly?: boolean;
  /** Shelves the reader has put the book on. */
  tags?: string[];
  /** When the reader last edited the title, author or shelves; the newer edit wins when devices sync. */
  infoAt?: number;
  /** Cached epub.js locations (JSON), so percentages are available instantly on reopen. */
  epubLocations?: string;
}

export interface BookFile {
  bookId: string;
  data: Blob;
}

export type AnnotationType = 'highlight' | 'note' | 'bookmark';
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

/** Rectangle in page-relative coordinates (0..1). */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Stroke {
  id: string;
  tool: 'pen' | 'marker';
  color: string;
  /** Line width as a fraction of the surface width, so strokes scale with zoom. */
  width: number;
  /** Flat list of normalized points: x0, y0, x1, y1, … (each 0..1). */
  points: number[];
}

export interface Sketch {
  /** Aspect ratio (width / height) of the pad the sketch was drawn on. */
  aspect: number;
  strokes: Stroke[];
}

export interface Annotation {
  id: string;
  bookId: string;
  type: AnnotationType;
  /** Page index (PDF/DjVu) or spine index (EPUB), 0-based. */
  unit: number;
  /** EPUB only: range CFI for highlights/notes, point CFI for bookmarks. */
  cfi?: string;
  /** PDF/DjVu only: highlight rectangles on the page. */
  rects?: NormRect[];
  quote?: string;
  text?: string;
  color: HighlightColor;
  sketch?: Sketch | null;
  /** Human-readable position, e.g. "стор. 12" or a chapter title. */
  label: string;
  author: 'user' | 'agent';
  createdAt: number;
  updatedAt: number;
}

export interface InkPage {
  /** `${bookId}:${page}` */
  id: string;
  bookId: string;
  page: number;
  strokes: Stroke[];
  /** When the drawing last changed; the newer version of a page wins when devices sync. */
  updatedAt?: number;
}

/** Remembers a deletion so that sync removes the item on other devices instead of bringing it back. */
export interface Tombstone {
  /** `b:${bookId}` or `a:${annotationId}` */
  id: string;
  kind: 'book' | 'annotation';
  bookId: string;
  deletedAt: number;
}

/** What this device has already exchanged with the sync storage, per book. */
export interface SyncMeta {
  bookId: string;
  /** Fingerprint of the reading state (position, notes, drawings) as it was when last exchanged. */
  stateDigest: string;
  /** Version of the remote state that has been merged in. */
  pulledStateAt: number;
  /** Same two, for the recognised text of scanned pages. */
  ocrDigest: string;
  ocrPulledAt: number;
}

export interface TocItem {
  title: string;
  /** Page index or spine index, when it could be resolved. */
  unit?: number;
  /** EPUB only. */
  href?: string;
  children: TocItem[];
}

export interface SearchHit {
  unit: number;
  label: string;
  pre: string;
  match: string;
  post: string;
  /** EPUB only. */
  cfi?: string;
  /** PDF/DjVu only: which occurrence on the page this is (0-based). */
  matchIndex?: number;
}

/** What the reader reports when the user selects text. */
export interface SelectionInfo {
  text: string;
  unit: number;
  /** EPUB only. */
  cfi?: string;
  /** PDF/DjVu only: rectangles grouped by page. */
  pages?: { page: number; rects: NormRect[] }[];
  /** Viewport coordinates used to position the popup. */
  anchor: { x: number; top: number; bottom: number };
}

export type DrawTool = 'pen' | 'marker' | 'eraser';

export interface DrawState {
  tool: DrawTool;
  color: string;
  /** Line width in CSS pixels at the current zoom. */
  size: number;
}

export interface UiToolCall {
  id: string;
  label: string;
  status: 'run' | 'ok' | 'err';
}

export type UiPart = { type: 'text'; text: string } | { type: 'tool'; call: UiToolCall };

export type UiMessage =
  | { id: string; role: 'user'; text: string; quote?: string }
  | {
      id: string;
      role: 'assistant';
      parts: UiPart[];
      status: 'streaming' | 'done' | 'stopped' | 'error' | 'refused';
      note?: string;
    };

export interface ChatThread {
  /** Unique; conversations saved before there was a history are `${bookId}:${agentId}`. */
  id: string;
  bookId: string;
  agentId: string;
  /** The first question, shortened: what the conversation is listed under. */
  title?: string;
  createdAt?: number;
  ui: UiMessage[];
  /** Raw provider history (append-only), replayed verbatim on the next turn. */
  api: unknown[];
  /** Which API family `api` is written for; absent in threads saved before other providers existed. */
  format?: 'anthropic' | 'openai';
  updatedAt: number;
}

/** OCR result for one scanned page. */
export interface OcrPage {
  /** `${bookId}:${page}` */
  id: string;
  bookId: string;
  page: number;
  text: string;
  /** Recognised words with page-relative boxes (0..1, origin top-left). */
  words: { text: string; x: number; y: number; w: number; h: number }[];
  langs: string;
  createdAt: number;
}

/**
 * The plain text of a book, unit by unit (pages or chapters), kept so that a search across the
 * whole library does not have to open every file again. Derived data: rebuilt whenever needed.
 */
export interface BookText {
  bookId: string;
  units: string[];
  /** Chapter titles of an EPUB; `null` where a unit has no name of its own. */
  labels: (string | null)[];
  /** How many OCR pages went into this text; a different count means it is out of date. */
  ocrPages: number;
  builtAt: number;
}

// ---------- Study: topics, cards, memory palaces ----------

/** Something the reader has decided to learn: usually a book or a part of one. */
export interface StudyTopic {
  id: string;
  title: string;
  /** The book the material comes from, if any. */
  bookId?: string;
  /** Which part of it, in the reader's own words ("розділ 3", "стор. 10–25"). */
  scope?: string;
  /** What the reader wrote from memory the last time they tried to recall the topic. */
  recall?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One thing to remember, asked as a question. The scheduling fields are the card's memory state
 * in the FSRS model (see lib/fsrs.ts); `due` is when it should be asked again.
 */
export interface StudyCard {
  id: string;
  topicId: string;
  front: string;
  back: string;
  /** Where in the book it comes from. */
  bookId?: string;
  unit?: number;
  label?: string;
  quote?: string;
  /** Method of loci: the place in a memory palace where this item is kept, and the image that holds it there. */
  palaceId?: string;
  locusId?: string;
  image?: string;
  /** The image, drawn. */
  sketch?: Sketch | null;
  state: 'new' | 'learning' | 'review' | 'relearning';
  due: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReview?: number;
  scheduledDays: number;
  /** When the card was first answered; new cards per day are counted by it. */
  introducedAt?: number;
  author: 'user' | 'agent';
  createdAt: number;
  updatedAt: number;
}

/** A route through a place the reader knows well; items to remember are "left" at its stops. */
export interface MemoryPalace {
  id: string;
  name: string;
  /** The stops, in the order they are walked. */
  loci: { id: string; name: string }[];
  createdAt: number;
  updatedAt: number;
}

/** One answer given in a review; kept for statistics. */
export interface ReviewLog {
  id: string;
  cardId: string;
  topicId: string;
  at: number;
  rating: 1 | 2 | 3 | 4;
  /** Days since the previous review; `null` for the first answer to a new card. */
  elapsedDays: number | null;
}

/** A deleted conversation with an agent, remembered so that sync removes it on other devices too. */
export interface ChatTombstone {
  /** Id of the conversation. */
  id: string;
  deletedAt: number;
}

/** A deleted topic, card or palace, remembered so that sync removes it on other devices too. */
export interface StudyTombstone {
  /** `t:<id>`, `c:<id>` or `p:<id>`. */
  id: string;
  deletedAt: number;
}

/** Semantic search index of one book: text chunks and their embedding vectors. */
export interface VectorIndex {
  bookId: string;
  /** Identifies the embedding model; queries must be embedded with the same one. */
  model: string;
  dims: number;
  chunks: { unit: number; text: string }[];
  /** `chunks.length * dims` unit-length vectors, row after row. */
  vectors: Float32Array;
  createdAt: number;
}
