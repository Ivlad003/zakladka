import type { BookFormat, OcrPage, SearchHit, TocItem } from '../types';
import { searchUnits } from './search';
import type { FixedEngine, PageLayout, PageSize, RenderHandle, SearchOptions, TextLayerHandle } from './types';
import { buildZoneLayer, layoutFromZones } from './zones';

/**
 * Wraps a PDF/DjVu engine and fills in OCR results wherever a page has no text of its own.
 * Everything built on page text — search, selection, highlights, what the AI agents read —
 * then works on scanned pages too.
 */
export class OcrLayeredEngine implements FixedEngine {
  readonly kind = 'fixed' as const;
  readonly format: BookFormat;
  readonly unitCount: number;
  readonly metadata: { title?: string; author?: string };
  /** Fired when the text of a page changes (OCR finished or was cleared). */
  onTextChanged?: (page: number) => void;

  private pages = new Map<number, OcrPage>();

  constructor(private inner: FixedEngine) {
    this.format = inner.format;
    this.unitCount = inner.unitCount;
    this.metadata = inner.metadata;
  }

  get pageSizes(): PageSize[] {
    return this.inner.pageSizes;
  }

  get onPageSize(): (() => void) | undefined {
    return this.inner.onPageSize;
  }

  set onPageSize(fn: (() => void) | undefined) {
    this.inner.onPageSize = fn;
  }

  // ---- OCR store ----
  load(pages: OcrPage[]): void {
    for (const p of pages) this.pages.set(p.page, p);
  }

  setPage(page: OcrPage): void {
    this.pages.set(page.page, page);
    this.onTextChanged?.(page.page);
  }

  clear(): void {
    const affected = [...this.pages.keys()];
    this.pages.clear();
    affected.forEach((p) => this.onTextChanged?.(p));
  }

  hasOcr(page: number): boolean {
    return this.pages.has(page);
  }

  get ocrCount(): number {
    return this.pages.size;
  }

  /** Text stored in the file itself, ignoring OCR. */
  getNativeText(page: number): Promise<string> {
    return this.inner.getUnitText(page);
  }

  // ---- Text: the file's own layer wins, OCR fills the gaps ----
  async getUnitText(unit: number): Promise<string> {
    const native = await this.inner.getUnitText(unit);
    if (native.trim()) return native;
    return this.pages.get(unit)?.text ?? native;
  }

  async buildTextLayer(index: number, container: HTMLElement, cssScale: number): Promise<TextLayerHandle> {
    const ocr = this.pages.get(index);
    const native = ocr ? await this.inner.getUnitText(index).catch(() => '') : 'native';
    if (!ocr || native.trim()) return this.inner.buildTextLayer(index, container, cssScale);
    const setScale = (s: number) => container.style.setProperty('--scale-factor', String(s));
    setScale(cssScale);
    buildZoneLayer(
      container,
      ocr.words.map((w) => ({ text: w.text, x: w.x, y: w.y, w: w.w, h: w.h })),
      this.pageSizes[index],
    );
    return { update: setScale, cancel: () => {} };
  }

  search(query: string, opts?: SearchOptions): Promise<SearchHit[]> {
    return searchUnits(this.unitCount, (i) => this.getUnitText(i), (i) => `стор. ${i + 1}`, query, opts);
  }

  // ---- Everything else is the wrapped engine's business ----
  render(index: number, canvas: HTMLCanvasElement, pixelWidth: number, pixelHeight: number): RenderHandle {
    return this.inner.render(index, canvas, pixelWidth, pixelHeight);
  }

  renderImage(index: number, maxWidth: number): Promise<Blob> {
    return this.inner.renderImage(index, maxWidth);
  }

  /** The file's own layout, or for a page recognised by OCR, the layout of the recognised words. */
  async getUnitLayout(unit: number): Promise<PageLayout | null> {
    const layout = this.inner.getUnitLayout ? await this.inner.getUnitLayout(unit) : null;
    if (layout?.lines.some((l) => l.text.trim())) return layout;
    // A scanned page: the recognised words carry their boxes too.
    const ocr = this.pages.get(unit);
    return ocr?.words.length ? layoutFromZones(ocr.words.map((w) => ({ text: w.text, x: w.x, y: w.y, w: w.w, h: w.h })), this.pageSizes[unit]) : null;
  }

  /** Contents made from the text, given out when the file has none of its own. */
  private madeToc: TocItem[] = [];

  setMadeToc(items: TocItem[]): void {
    this.madeToc = items;
  }

  /** Whether the file itself has a table of contents. */
  async hasOwnToc(): Promise<boolean> {
    return (await this.inner.getToc().catch(() => [])).length > 0;
  }

  async getToc(): Promise<TocItem[]> {
    const own = await this.inner.getToc().catch(() => []);
    return own.length ? own : this.madeToc;
  }

  makeCover(): Promise<Blob | null> {
    return this.inner.makeCover();
  }

  destroy(): void {
    this.inner.destroy();
  }
}
