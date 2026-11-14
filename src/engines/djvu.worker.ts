// Decodes DjVu off the main thread with djvu-rs (MIT, pure Rust compiled to WebAssembly).
import init, { WasmDocument, wasmSimd128Supported } from 'djvu-rs';
// The package only exports its entry module, so the two wasm builds are referenced by file path.
import scalarWasm from '../../node_modules/djvu-rs/scalar/djvu_rs_bg.wasm?url';
import simdWasm from '../../node_modules/djvu-rs/simd128/djvu_rs_bg.wasm?url';
import type { TocItem } from '../types';
import { readDjvuOutline } from './djvu-outline';
import type { TextZone } from './zones';

export type DjvuRequest =
  | { id: number; type: 'open'; buffer: ArrayBuffer }
  | { id: number; type: 'render'; page: number; width: number }
  | { id: number; type: 'text'; page: number }
  | { id: number; type: 'zones'; page: number }
  | { id: number; type: 'cancel'; target: number };

export type DjvuResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export interface DjvuPageInfo {
  /** Pixel size at the page's native resolution. */
  width: number;
  height: number;
  dpi: number;
}

export interface DjvuOpenResult {
  pages: DjvuPageInfo[];
  contents: TocItem[];
}

export interface DjvuRenderResult {
  bitmap: ImageBitmap;
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<DjvuRequest>) => void) | null;
  postMessage(message: DjvuResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const DEFAULT_DPI = 300;
/** Pages are decoded at up to this multiple of the requested size, then smoothed down. */
const SUPERSAMPLE = 3;
const MAX_DECODE_PIXELS = 16_000_000;

let doc: WasmDocument | null = null;
let pages: DjvuPageInfo[] = [];
const cancelled = new Set<number>();
// One request at a time: decoding is CPU-bound, and a cancelled request can be skipped while it waits.
let queue: Promise<void> = Promise.resolve();

async function open(buffer: ArrayBuffer): Promise<DjvuOpenResult> {
  await init(wasmSimd128Supported() ? simdWasm : scalarWasm);
  const bytes = new Uint8Array(buffer);
  doc = WasmDocument.from_bytes(bytes);
  pages = [];
  const count = doc.page_count();
  for (let i = 0; i < count; i++) {
    const page = doc.page(i);
    const dpi = page.dpi() || DEFAULT_DPI;
    pages.push({ dpi, width: page.width_at(dpi), height: page.height_at(dpi) });
    page.free();
  }
  let contents: TocItem[] = [];
  try {
    contents = readDjvuOutline(bytes);
  } catch {
    // A missing or unreadable outline must never prevent the book from opening.
  }
  return { pages, contents };
}

async function render(index: number, width: number): Promise<[DjvuRenderResult, Transferable[]]> {
  const info = pages[index];
  const page = doc!.page(index);
  try {
    // Never ask for more than the scan holds; the canvas is scaled by CSS beyond that.
    const targetDpi = Math.max(8, Math.min(info.dpi, (info.dpi * width) / info.width));
    // The decoder subsamples without smoothing, which makes small text jagged. Decode with headroom
    // (bounded, since a page is 4 bytes per pixel) and let the browser resample it properly.
    const pixelCap = info.dpi * Math.sqrt(MAX_DECODE_PIXELS / (info.width * info.height));
    const decodeDpi = Math.max(targetDpi, Math.min(info.dpi, targetDpi * SUPERSAMPLE, pixelCap));
    const pixels = page.render(decodeDpi);
    // wasm-bindgen hands back a copy that we own, so it can back the ImageData directly.
    const image = new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, page.width_at(decodeDpi), page.height_at(decodeDpi));
    const outWidth = Math.max(1, Math.round((image.width * targetDpi) / decodeDpi));
    const outHeight = Math.max(1, Math.round((image.height * targetDpi) / decodeDpi));
    let bitmap: ImageBitmap;
    if (outWidth >= image.width) {
      bitmap = await createImageBitmap(image);
    } else {
      try {
        bitmap = await createImageBitmap(image, { resizeWidth: outWidth, resizeHeight: outHeight, resizeQuality: 'high' });
      } catch {
        bitmap = await createImageBitmap(image); // no resize support: the canvas scales it instead
      }
    }
    return [{ bitmap }, [bitmap]];
  } finally {
    page.free();
  }
}

function zones(index: number): TextZone[] {
  const info = pages[index];
  const page = doc!.page(index);
  try {
    const raw = JSON.parse(page.text_zones_json(info.dpi) ?? '[]') as { t: string; x: number; y: number; w: number; h: number }[];
    const out: TextZone[] = [];
    let last: (typeof raw)[number] | null = null;
    for (const z of raw) {
      // Many files store only line boxes: consecutive words then share one box and belong in one zone.
      if (last && last.x === z.x && last.y === z.y && last.w === z.w && last.h === z.h) {
        out[out.length - 1].text += ` ${z.t}`;
        continue;
      }
      out.push({ text: z.t, x: z.x / info.width, y: z.y / info.height, w: z.w / info.width, h: z.h / info.height });
      last = z;
    }
    return out;
  } finally {
    page.free();
  }
}

function text(index: number): string {
  const page = doc!.page(index);
  try {
    return page.text() ?? '';
  } finally {
    page.free();
  }
}

async function handle(req: Exclude<DjvuRequest, { type: 'cancel' }>): Promise<[unknown, Transferable[]]> {
  if (req.type === 'open') return [await open(req.buffer), []];
  if (!doc) throw new Error('Документ не відкрито');
  if (req.page < 0 || req.page >= pages.length) throw new Error(`Сторінки ${req.page + 1} не існує`);
  switch (req.type) {
    case 'render':
      return render(req.page, req.width);
    case 'text':
      return [{ text: text(req.page) }, []];
    case 'zones':
      return [{ zones: zones(req.page) }, []];
  }
}

scope.onmessage = (e) => {
  const req = e.data;
  if (req.type === 'cancel') {
    cancelled.add(req.target);
    return;
  }
  queue = queue.then(async () => {
    if (cancelled.delete(req.id)) {
      scope.postMessage({ id: req.id, ok: false, error: 'cancelled' });
      return;
    }
    try {
      const [result, transfer] = await handle(req);
      scope.postMessage({ id: req.id, ok: true, result }, transfer);
    } catch (err) {
      scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
};
