import { duringWork } from './busy';
import { db } from '../db';
import { detectFormat, openEngine } from '../engines';
import type { BookFormat, BookRecord } from '../types';
import { sha256Hex } from './hash';

/** PDF producers often leave the source file name in the Title field; a file name reads better then. */
function isUsableTitle(title: string | undefined): title is string {
  if (!title || title.length < 2) return false;
  return !/\.(docx?|rtf|indd|qxd|tex|dvi|pdf|pmd|cdr|html?|odt|pages)$/i.test(title) && !/^(microsoft word|untitled)/i.test(title);
}

export class UnsupportedFileError extends Error {}

/**
 * Formats the reader has no engine for but can turn into an EPUB: FB2 (plain or zipped), Kindle
 * books without DRM (MOBI, PRC, AZW, AZW3) and JW Library publications (JWPUB). Each converter is
 * loaded only when such a file turns up.
 */
async function convertToEpub(chosen: File): Promise<{ file: File; original: ArrayBuffer } | null> {
  const exact = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const named = (epub: Blob, ending: RegExp) => new File([epub], `${chosen.name.replace(ending, '')}.epub`, { type: 'application/epub+zip' });
  if (/\.jwpub$/i.test(chosen.name)) {
    const { jwpubToEpub } = await import('../engines/jwpub');
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    return { file: named((await jwpubToEpub(bytes)).epub, /\.jwpub$/i), original: exact(bytes) };
  }
  if (/\.(fb2|fb2\.zip|fbz|zip)$/i.test(chosen.name)) {
    const { readFb2, fb2ToEpub } = await import('../engines/fb2');
    const fb2 = await readFb2(chosen);
    if (fb2) return { file: named((await fb2ToEpub(fb2)).epub, /\.(fb2\.zip|fbz|fb2|zip)$/i), original: exact(fb2) };
  }
  // Kindle books are told by their signature: the extension may be .mobi, .prc, .azw or .azw3.
  const head = new Uint8Array(await chosen.slice(0, 68).arrayBuffer());
  if (head.length === 68 && String.fromCharCode(...head.subarray(60, 68)) === 'BOOKMOBI') {
    const { mobiToEpub } = await import('../engines/mobi');
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    return { file: named((await mobiToEpub(bytes)).epub, /\.(mobi|prc|azw3?|kf8)$/i), original: exact(bytes) };
  }
  return null;
}

/** Adds a file to the library and returns the book id (the existing id if it was already imported). */
export async function importBook(chosen: File): Promise<string> {
  // FB2, MOBI and JWPUB become an EPUB on the way in. The id still comes from the original, so the
  // same book added on two devices — zipped on one, plain on the other — is one book to the sync.
  const converted = await convertToEpub(chosen);
  const file = converted?.file ?? chosen;
  const format = await detectFormat(file);
  if (!format) throw new UnsupportedFileError(`«${chosen.name}»: підтримуються EPUB, PDF, DjVu, FB2, MOBI та JWPUB`);
  // The id is a hash of the file, so the same book gets the same id on every device and its
  // notes and reading position meet when the devices sync.
  const idOfFile = async () => (await sha256Hex(converted?.original ?? (await file.arrayBuffer()))).slice(0, 32);

  // A book whose whole text sits in one file (or a few huge ones) is slow to read: such files are
  // cut into chapters before the book is kept. Places in a book are counted in its files, so the
  // cut book is another book than the same file kept whole (by an earlier version of the app, on
  // this device or another): it gets an id of its own, and their notes and places never mix.
  if (format === 'epub') {
    const cutting = await import('../engines/epub-split').catch(() => null);
    const cut = await cutting?.splitLargeChapters(file).catch(() => null);
    if (cutting && cut) {
      const id = (await sha256Hex(new TextEncoder().encode(`${await idOfFile()}:${cutting.CUT_VERSION}`).buffer as ArrayBuffer)).slice(0, 32);
      // The book as it came is still a book, should the cut one fail to open.
      const kept = await keepBook(id, new File([cut], file.name, { type: 'application/epub+zip' }), format).catch(() => null);
      if (kept) return kept;
    }
  }

  // Books added before ids were derived from the content are recognised by name and size.
  const legacy = await db.books.filter((b) => b.fileName === file.name && b.size === file.size && !b.cloudOnly).first();
  if (legacy) return legacy.id;
  return keepBook(await idOfFile(), file, format);
}

/** Puts a book into the library under the id, unless it is there already. */
async function keepBook(id: string, file: File, format: BookFormat): Promise<string> {
  const existing = await db.books.get(id);
  if (existing) {
    if (existing.cloudOnly) {
      // Known from sync, file not downloaded yet: the user has just supplied it.
      await db.transaction('rw', db.books, db.files, async () => {
        await db.files.put({ bookId: id, data: file });
        await db.books.update(id, { cloudOnly: false });
      });
    }
    return id;
  }

  // Engines may take ownership of the buffer, so each one gets its own copy.
  const engine = await openEngine(format, await file.arrayBuffer());
  try {
    const cover = await engine.makeCover().catch(() => null);
    const record: BookRecord = {
      id,
      title: isUsableTitle(engine.metadata.title) ? engine.metadata.title : file.name.replace(/\.[^.]+$/, ''),
      author: engine.metadata.author ?? '',
      format,
      size: file.size,
      fileName: file.name,
      addedAt: Date.now(),
      lastOpenedAt: 0,
      progress: 0,
      position: null,
      unitCount: engine.unitCount,
      cover,
    };
    await db.transaction('rw', db.books, db.files, db.tombstones, async () => {
      await db.books.add(record);
      await db.files.add({ bookId: record.id, data: file });
      // Added again after having been deleted: the old deletion no longer applies.
      await db.tombstones.delete(`b:${record.id}`);
    });
    // Ask the browser not to evict the library under storage pressure.
    void navigator.storage?.persist?.();
    return record.id;
  } finally {
    engine.destroy();
  }
}

export interface ImportResult {
  ids: string[];
  errors: string[];
}

export function importBooks(files: Iterable<File>): Promise<ImportResult> {
  return duringWork(importBooksNow(files));
}

async function importBooksNow(files: Iterable<File>): Promise<ImportResult> {
  const result: ImportResult = { ids: [], errors: [] };
  for (const file of files) {
    try {
      result.ids.push(await importBook(file));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.errors.push(err instanceof UnsupportedFileError ? reason : `«${file.name}»: не вдалося відкрити (${reason})`);
    }
  }
  return result;
}
