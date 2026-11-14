import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { SearchHit, TocItem } from '../types';
import { canvasToBlob } from '../lib/utils';
import { searchUnits } from './search';
import { RenderCancelled, type FixedEngine, type PageSize, type RenderHandle, type SearchOptions, type TextLayerHandle } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const BASE = import.meta.env.BASE_URL;
/** PDF user units are 1/72 inch; CSS pixels are 1/96 inch. */
const CSS_UNITS = 96 / 72;
/** Above this page count, sizes are assumed equal to page 1 and corrected as pages load. */
const EAGER_SIZE_LIMIT = 400;

type OutlineNode = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>[number];

function sizeOf(page: PDFPageProxy): PageSize {
  const vp = page.getViewport({ scale: CSS_UNITS });
  return { width: vp.width, height: vp.height };
}

export class PdfEngine implements FixedEngine {
  readonly format = 'pdf' as const;
  readonly kind = 'fixed' as const;
  unitCount = 0;
  metadata: { title?: string; author?: string } = {};
  pageSizes: PageSize[] = [];
  onPageSize?: () => void;

  private textCache = new Map<number, string>();

  private constructor(private doc: PDFDocumentProxy) {}

  static async open(data: ArrayBuffer): Promise<PdfEngine> {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(data),
      cMapUrl: `${BASE}pdfjs/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`,
      isEvalSupported: false,
    }).promise;

    const engine = new PdfEngine(doc);
    engine.unitCount = doc.numPages;

    const first = sizeOf(await doc.getPage(1));
    engine.pageSizes = Array.from({ length: doc.numPages }, () => ({ ...first }));
    if (doc.numPages <= EAGER_SIZE_LIMIT) {
      await Promise.all(
        engine.pageSizes.map(async (_, i) => {
          if (i > 0) engine.pageSizes[i] = sizeOf(await doc.getPage(i + 1));
        }),
      );
    }

    try {
      const info = (await doc.getMetadata()).info as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      engine.metadata = { title: str(info.Title), author: str(info.Author) };
    } catch {
      // Metadata is optional.
    }
    return engine;
  }

  private async page(index: number): Promise<PDFPageProxy> {
    const page = await this.doc.getPage(index + 1);
    const actual = sizeOf(page);
    const known = this.pageSizes[index];
    if (Math.abs(actual.width - known.width) > 0.5 || Math.abs(actual.height - known.height) > 0.5) {
      this.pageSizes[index] = actual;
      this.onPageSize?.();
    }
    return page;
  }

  render(index: number, canvas: HTMLCanvasElement, pixelWidth: number, pixelHeight: number): RenderHandle {
    return this.renderPage(index, canvas, pixelWidth, pixelHeight, 'display');
  }

  /**
   * With the "display" intent PDF.js paces its work with animation frames, which stop while the tab is
   * in the background. Off-screen jobs (OCR, covers, page images for AI) use "print", which does not wait.
   */
  private renderPage(index: number, canvas: HTMLCanvasElement, pixelWidth: number, pixelHeight: number, intent: 'display' | 'print'): RenderHandle {
    let task: RenderTask | null = null;
    let cancelled = false;
    const promise = (async () => {
      const page = await this.page(index);
      if (cancelled) throw new RenderCancelled();
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pixelWidth / base.width });
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Canvas недоступний');
      task = page.render({ canvasContext: ctx, viewport, intent });
      try {
        await task.promise;
      } catch (err) {
        if (cancelled) throw new RenderCancelled();
        throw err;
      }
    })();
    return {
      promise,
      cancel() {
        cancelled = true;
        task?.cancel();
      },
    };
  }

  async buildTextLayer(index: number, container: HTMLElement, cssScale: number): Promise<TextLayerHandle> {
    const page = await this.page(index);
    const viewportFor = (s: number) => page.getViewport({ scale: s * CSS_UNITS });
    const viewport = viewportFor(cssScale);
    container.style.setProperty('--scale-factor', String(viewport.scale));
    const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
    await layer.render();
    // Keeps a drag-selection from jumping to the whole page when the pointer leaves the text.
    const end = document.createElement('div');
    end.className = 'endOfContent';
    container.append(end);
    return {
      update(s) {
        const vp = viewportFor(s);
        container.style.setProperty('--scale-factor', String(vp.scale));
        layer.update({ viewport: vp });
      },
      cancel: () => layer.cancel(),
    };
  }

  async renderImage(index: number, maxWidth: number): Promise<Blob> {
    const size = this.pageSizes[index];
    const width = Math.round(Math.min(maxWidth, size.width * 2));
    const height = Math.round((width * size.height) / size.width);
    const canvas = document.createElement('canvas');
    await this.renderPage(index, canvas, width, height, 'print').promise;
    return canvasToBlob(canvas, 'image/jpeg', 0.85);
  }

  async getUnitText(unit: number): Promise<string> {
    const cached = this.textCache.get(unit);
    if (cached !== undefined) return cached;
    const page = await this.doc.getPage(unit + 1);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if ('str' in item) {
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
    }
    this.textCache.set(unit, text);
    return text;
  }

  search(query: string, opts?: SearchOptions): Promise<SearchHit[]> {
    return searchUnits(this.unitCount, (i) => this.getUnitText(i), (i) => `стор. ${i + 1}`, query, opts);
  }

  async getToc(): Promise<TocItem[]> {
    const outline = await this.doc.getOutline();
    if (!outline) return [];
    const convert = (nodes: OutlineNode[]): Promise<TocItem[]> =>
      Promise.all(
        nodes.map(async (node) => ({
          title: node.title?.trim() || '—',
          unit: await this.destToPage(node.dest),
          children: node.items?.length ? await convert(node.items) : [],
        })),
      );
    return convert(outline);
  }

  private async destToPage(dest: OutlineNode['dest']): Promise<number | undefined> {
    try {
      const explicit = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return undefined;
      const ref = explicit[0];
      if (typeof ref === 'number') return ref;
      return await this.doc.getPageIndex(ref);
    } catch {
      return undefined;
    }
  }

  async makeCover(): Promise<Blob | null> {
    return this.renderImage(0, 360);
  }

  destroy(): void {
    void this.doc.destroy();
  }
}
