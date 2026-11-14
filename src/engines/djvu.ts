import type { SearchHit, TocItem } from '../types';
import { canvasToBlob } from '../lib/utils';
import type { DjvuOpenResult, DjvuRenderResult, DjvuRequest, DjvuResponse } from './djvu.worker';
import { searchUnits } from './search';
import { RenderCancelled, type FixedEngine, type PageLayout, type PageSize, type RenderHandle, type SearchOptions, type TextLayerHandle } from './types';
import { buildZoneLayer, layoutFromZones, type TextZone } from './zones';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Payload = DistributiveOmit<DjvuRequest, 'id'>;

export class DjvuEngine implements FixedEngine {
  readonly format = 'djvu' as const;
  readonly kind = 'fixed' as const;
  unitCount = 0;
  metadata: { title?: string; author?: string } = {};
  pageSizes: PageSize[] = [];
  onPageSize?: () => void;

  private worker = new Worker(new URL('./djvu.worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private toc: TocItem[] = [];
  private textCache = new Map<number, string>();

  private constructor() {
    this.worker.onmessage = (e: MessageEvent<DjvuResponse>) => {
      const msg = e.data;
      const entry = this.pending.get(msg.id);
      if (!entry) {
        // The request was cancelled on our side; release the bitmap if one still arrived.
        if (msg.ok) (msg.result as Partial<DjvuRenderResult> | null)?.bitmap?.close();
        return;
      }
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(msg.error === 'cancelled' ? new RenderCancelled() : new Error(msg.error));
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Помилка обробки DjVu');
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
    };
  }

  static async open(data: ArrayBuffer): Promise<DjvuEngine> {
    const engine = new DjvuEngine();
    try {
      const info = (await engine.call({ type: 'open', buffer: data }, [data]).promise) as DjvuOpenResult;
      engine.unitCount = info.pages.length;
      engine.pageSizes = info.pages.map((p) => ({ width: (p.width * 96) / p.dpi, height: (p.height * 96) / p.dpi }));
      engine.toc = info.contents;
      return engine;
    } catch (err) {
      engine.destroy();
      throw err;
    }
  }

  private call(payload: Payload, transfer: Transferable[] = []): { id: number; promise: Promise<unknown> } {
    const id = ++this.seq;
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.worker.postMessage({ ...payload, id }, transfer);
    return { id, promise };
  }

  render(index: number, canvas: HTMLCanvasElement, pixelWidth: number): RenderHandle {
    const { id, promise } = this.call({ type: 'render', page: index, width: pixelWidth });
    return {
      promise: promise.then((result) => {
        const { bitmap } = result as DjvuRenderResult;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas недоступний');
        // Paper-white base, so transparent pixels do not turn black in JPEG covers and page images.
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
      }),
      cancel: () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        this.worker.postMessage({ id: 0, type: 'cancel', target: id } satisfies DjvuRequest);
        entry.reject(new RenderCancelled());
      },
    };
  }

  async buildTextLayer(index: number, container: HTMLElement, cssScale: number): Promise<TextLayerHandle> {
    const { zones } = (await this.call({ type: 'zones', page: index }).promise) as { zones: TextZone[] };
    const setScale = (s: number) => container.style.setProperty('--scale-factor', String(s));
    setScale(cssScale);
    buildZoneLayer(container, zones, this.pageSizes[index]);
    return { update: setScale, cancel: () => {} };
  }

  /** Lines of the page from its text layer's boxes (for the text mode). */
  async getUnitLayout(unit: number): Promise<PageLayout | null> {
    const { zones } = (await this.call({ type: 'zones', page: unit }).promise) as { zones: TextZone[] };
    return zones.length ? layoutFromZones(zones, this.pageSizes[unit]) : null;
  }

  async renderImage(index: number, maxWidth: number): Promise<Blob> {
    const canvas = document.createElement('canvas');
    await this.render(index, canvas, maxWidth).promise;
    return canvasToBlob(canvas, 'image/jpeg', 0.85);
  }

  async getUnitText(unit: number): Promise<string> {
    const cached = this.textCache.get(unit);
    if (cached !== undefined) return cached;
    const { text } = (await this.call({ type: 'text', page: unit }).promise) as { text: string };
    this.textCache.set(unit, text);
    return text;
  }

  search(query: string, opts?: SearchOptions): Promise<SearchHit[]> {
    return searchUnits(this.unitCount, (i) => this.getUnitText(i), (i) => `стор. ${i + 1}`, query, opts);
  }

  async getToc(): Promise<TocItem[]> {
    return this.toc;
  }

  async makeCover(): Promise<Blob | null> {
    return this.renderImage(0, 360);
  }

  destroy(): void {
    this.worker.terminate();
    const err = new RenderCancelled();
    this.pending.forEach((p) => p.reject(err));
    this.pending.clear();
  }
}
