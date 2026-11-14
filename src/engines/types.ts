import type { Book } from 'epubjs';
import type { BookFormat, SearchHit, TocItem } from '../types';

export interface PageSize {
  /** CSS pixels at 100% zoom. */
  width: number;
  height: number;
}

export interface SearchOptions {
  signal?: AbortSignal;
  limit?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface EngineBase {
  readonly format: BookFormat;
  readonly kind: 'fixed' | 'epub';
  /** Pages (PDF/DjVu) or spine sections (EPUB). */
  readonly unitCount: number;
  readonly metadata: { title?: string; author?: string };
  getToc(): Promise<TocItem[]>;
  getUnitText(unit: number): Promise<string>;
  search(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  makeCover(): Promise<Blob | null>;
  destroy(): void;
}

export interface RenderHandle {
  promise: Promise<void>;
  cancel(): void;
}

export interface TextLayerHandle {
  /** Called when the zoom changes; the layer is rescaled in place. */
  update(cssScale: number): void;
  cancel(): void;
}

/** One line of text on a page, in page units with the origin at the top left. */
export interface PageLine {
  text: string;
  /** Left and right ends of the line. */
  x: number;
  xEnd: number;
  /** Baseline, measured from the top of the page. */
  y: number;
  /** Font size. */
  size: number;
}

export interface PageLayout {
  width: number;
  height: number;
  lines: PageLine[];
}

export interface FixedEngine extends EngineBase {
  readonly kind: 'fixed';
  /** May be corrected lazily for very long documents; `onPageSize` fires when it changes. */
  pageSizes: PageSize[];
  onPageSize?: () => void;
  /** Fires when the text of a page changes after opening (OCR results arriving). */
  onTextChanged?: (page: number) => void;
  /** Draws the page into `canvas` at the given pixel size. */
  render(index: number, canvas: HTMLCanvasElement, pixelWidth: number, pixelHeight: number): RenderHandle;
  /** Fills `container` with invisible, selectable text positioned over the page image. */
  buildTextLayer(index: number, container: HTMLElement, cssScale: number): Promise<TextLayerHandle>;
  /** JPEG of the page, at most `maxWidth` pixels wide. */
  renderImage(index: number, maxWidth: number): Promise<Blob>;
  /** The page's lines of text with where they sit and how big they are; absent where the format cannot tell. */
  getUnitLayout?(unit: number): Promise<PageLayout | null>;
}

export interface EpubEngineLike extends EngineBase {
  readonly kind: 'epub';
  readonly book: Book;
  /** Best chapter title for a spine index. */
  titleForUnit(unit: number): string | undefined;
  ensureLocations(saved?: string): Promise<string | null>;
  percentageFromCfi(cfi: string): number | null;
  /** CFI of the place in a section where the given passage starts, if it can be found. */
  locatePassage(unit: number, passage: string): Promise<string | null>;
  cfiFromPercentage(p: number): string | null;
  compareCfi(a: string, b: string): number;
}

export type Engine = FixedEngine | EpubEngineLike;

export class RenderCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'RenderCancelled';
  }
}
