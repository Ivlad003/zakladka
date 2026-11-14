import { duringWork } from './busy';
import { db } from '../db';
import { detectFormat, openEngine } from '../engines';
import type { BookRecord } from '../types';
import { sha256Hex } from './hash';

/** PDF producers often leave the source file name in the Title field; a file name reads better then. */
function isUsableTitle(title: string | undefined): title is string {
  if (!title || title.length < 2) return false;
  return !/\.(docx?|rtf|indd|qxd|tex|dvi|pdf|pmd|cdr)$/i.test(title) && !/^(microsoft word|untitled)/i.test(title);
}

export class UnsupportedFileError extends Error {}

/** Adds a file to the library and returns the book id (the existing id if it was already imported). */
export async function importBook(chosen: File): Promise<string> {
  // FB2 becomes an EPUB on the way in. The id still comes from the FB2 itself, so the same book
  // added on two devices — zipped on one, plain on the other — is one book to the sync.
  let file = chosen;
  // The converter is loaded only when a file looks like FB2: most readers never need it.
  const converter = /\.(fb2|fb2\.zip|fbz|zip)$/i.test(chosen.name) ? await import('../engines/fb2') : null;
  const fb2 = converter ? await converter.readFb2(chosen) : null;
  if (converter && fb2) {
    const converted = await converter.fb2ToEpub(fb2);
    file = new File([converted.epub], `${chosen.name.replace(/\.(fb2\.zip|fbz|fb2|zip)$/i, '')}.epub`, { type: 'application/epub+zip' });
  }
  const format = await detectFormat(file);
  if (!format) throw new UnsupportedFileError(`«${chosen.name}»: підтримуються EPUB, PDF, DjVu та FB2`);

  // Books added before ids were derived from the content are recognised by name and size.
  const legacy = await db.books.filter((b) => b.fileName === file.name && b.size === file.size && !b.cloudOnly).first();
  if (legacy) return legacy.id;

  // The id is a hash of the file, so the same book gets the same id on every device and its
  // notes and reading position meet when the devices sync.
  const id = (await sha256Hex(fb2 ? (fb2.buffer.slice(fb2.byteOffset, fb2.byteOffset + fb2.byteLength) as ArrayBuffer) : await file.arrayBuffer())).slice(0, 32);
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
