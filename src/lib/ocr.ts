import { duringWork } from './busy';
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';
import { db } from '../db';
import type { OcrLayeredEngine } from '../engines/ocr-engine';
import type { OcrPage } from '../types';

export const OCR_LANGS: { code: string; name: string }[] = [
  { code: 'ukr', name: 'Українська' },
  { code: 'eng', name: 'English' },
  { code: 'pol', name: 'Polski' },
  { code: 'deu', name: 'Deutsch' },
  { code: 'fra', name: 'Français' },
  { code: 'spa', name: 'Español' },
  { code: 'ita', name: 'Italiano' },
  { code: 'ces', name: 'Čeština' },
  { code: 'rus', name: 'Русский' },
];

export interface OcrProgress {
  /** Pages finished (recognised or skipped) and pages requested. */
  done: number;
  total: number;
  recognized: number;
  /** What is happening right now, for the status line. */
  status: string;
}

export interface OcrJobOptions {
  engine: OcrLayeredEngine;
  bookId: string;
  /** 0-based page indices to process, in order. */
  pages: number[];
  langs: string[];
  /** Recognise again even where an earlier run already produced text (e.g. after changing languages). */
  force?: boolean;
  signal: AbortSignal;
  onProgress(progress: OcrProgress): void;
}

const BASE = import.meta.env.BASE_URL;
/** About 200 dpi for an A4/Letter page: enough for body text without slowing recognition much. */
const OCR_WIDTH = 1800;
const MIN_NATIVE_CHARS = 8;

export const ocrId = (bookId: string, page: number) => `${bookId}:${page}`;

/**
 * Recognises text on scanned pages with Tesseract (WebAssembly, runs in a worker on this device).
 * Pages that already have text — their own or from an earlier run — are skipped, so a job can be
 * stopped and resumed. Language data is downloaded once per language and then cached by the browser.
 */
export function runOcr(opts: OcrJobOptions): Promise<OcrProgress> {
  return duringWork(runOcrNow(opts));
}

async function runOcrNow(opts: OcrJobOptions): Promise<OcrProgress> {
  const { engine, bookId, pages, langs, signal } = opts;
  const progress: OcrProgress = { done: 0, total: pages.length, recognized: 0, status: 'Завантажую рушій розпізнавання…' };
  const report = (patch: Partial<OcrProgress>) => opts.onProgress(Object.assign(progress, patch));
  report({});

  let worker: TesseractWorker | null = null;
  const stop = () => void worker?.terminate();
  signal.addEventListener('abort', stop);

  try {
    for (const page of pages) {
      if (signal.aborted) break;
      const native = await engine.getNativeText(page);
      if (native.trim().length >= MIN_NATIVE_CHARS || (!opts.force && engine.hasOcr(page))) {
        report({ done: progress.done + 1 });
        continue;
      }

      // Started lazily: a book whose pages all have text never loads the OCR engine.
      worker ??= await createWorker(langs, 1, {
        workerPath: `${BASE}tesseract/worker.min.js`,
        corePath: `${BASE}tesseract`,
        logger: (m) => {
          if (m.status.includes('loading language')) report({ status: 'Завантажую мовні дані (лише першого разу)…' });
        },
      });
      if (signal.aborted) break;

      report({ status: `Розпізнаю сторінку ${page + 1}…` });
      const image = await engine.renderImage(page, OCR_WIDTH);
      const bitmap = await createImageBitmap(image);
      const { width, height } = bitmap;
      bitmap.close();
      const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
      if (signal.aborted) break;

      const words: OcrPage['words'] = [];
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            for (const word of line.words) {
              const text = word.text.trim();
              if (!text) continue;
              const { x0, y0, x1, y1 } = word.bbox;
              words.push({ text, x: x0 / width, y: y0 / height, w: (x1 - x0) / width, h: (y1 - y0) / height });
            }
          }
        }
      }

      const record: OcrPage = { id: ocrId(bookId, page), bookId, page, text: data.text.trim(), words, langs: langs.join('+'), createdAt: Date.now() };
      await db.ocr.put(record);
      engine.setPage(record);
      report({ done: progress.done + 1, recognized: progress.recognized + 1 });
    }
  } finally {
    signal.removeEventListener('abort', stop);
    await worker?.terminate().catch(() => {});
  }
  report({ status: signal.aborted ? 'Зупинено' : 'Готово' });
  return progress;
}

export async function clearOcr(engine: OcrLayeredEngine, bookId: string): Promise<void> {
  await db.ocr.where('bookId').equals(bookId).delete();
  engine.clear();
}
