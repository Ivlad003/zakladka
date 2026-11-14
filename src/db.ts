import Dexie, { type EntityTable } from 'dexie';
import type {
  Annotation,
  BookFile,
  BookRecord,
  BookText,
  ChatThread,
  ChatTombstone,
  ReflowCopy,
  AutoTocRecord,
  ReadingDay,
  StoredAsset,
  XrayRecord,
  InkPage,
  MemoryPalace,
  OcrPage,
  ReviewLog,
  StudyCard,
  StudyTombstone,
  StudyTopic,
  SyncMeta,
  Tombstone,
  VectorIndex,
} from './types';

class AppDB extends Dexie {
  books!: EntityTable<BookRecord, 'id'>;
  files!: EntityTable<BookFile, 'bookId'>;
  annotations!: EntityTable<Annotation, 'id'>;
  ink!: EntityTable<InkPage, 'id'>;
  chats!: EntityTable<ChatThread, 'id'>;
  ocr!: EntityTable<OcrPage, 'id'>;
  vectors!: EntityTable<VectorIndex, 'bookId'>;
  tombstones!: EntityTable<Tombstone, 'id'>;
  syncMeta!: EntityTable<SyncMeta, 'bookId'>;
  texts!: EntityTable<BookText, 'bookId'>;
  topics!: EntityTable<StudyTopic, 'id'>;
  cards!: EntityTable<StudyCard, 'id'>;
  palaces!: EntityTable<MemoryPalace, 'id'>;
  reviews!: EntityTable<ReviewLog, 'id'>;
  studyTombs!: EntityTable<StudyTombstone, 'id'>;
  chatTombs!: EntityTable<ChatTombstone, 'id'>;
  reflows!: EntityTable<ReflowCopy, 'bookId'>;
  tocs!: EntityTable<AutoTocRecord, 'bookId'>;
  readingLog!: EntityTable<ReadingDay, 'id'>;
  assets!: EntityTable<StoredAsset, 'id'>;
  xray!: EntityTable<XrayRecord, 'bookId'>;

  constructor() {
    super('zakladka');
    this.version(1).stores({
      books: 'id, lastOpenedAt, addedAt',
      files: 'bookId',
      annotations: 'id, bookId, [bookId+type]',
      ink: 'id, bookId',
      chats: 'id, bookId',
    });
    // v2: OCR text of scanned pages and per-book semantic search indexes.
    this.version(2).stores({
      ocr: 'id, bookId',
      vectors: 'bookId',
    });
    // v3: bookkeeping for cross-device sync.
    this.version(3).stores({
      tombstones: 'id, bookId, kind',
      syncMeta: 'bookId',
    });
    // v4: plain text of every book, for searching the whole library at once.
    this.version(4).stores({
      texts: 'bookId',
    });
    // v5: study — topics, cards with their review schedule, memory palaces.
    this.version(5).stores({
      topics: 'id, bookId',
      cards: 'id, topicId, due, palaceId',
      palaces: 'id',
      reviews: 'id, cardId, at',
      studyTombs: 'id',
    });
    // v6: deleted conversations, so that sync can remove them elsewhere.
    this.version(6).stores({
      chatTombs: 'id',
    });
    // v7: the text-mode copies of PDF and DjVu books.
    this.version(7).stores({
      reflows: 'bookId',
    });
    // v8: tables of contents made from the text of books that have none.
    this.version(8).stores({
      tocs: 'bookId',
    });
    // v9: the reading log behind the statistics.
    this.version(9).stores({
      readingLog: 'id, day, bookId',
      assets: 'id',
      xray: 'bookId',
    });
  }
}

export const db = new AppDB();

export async function deleteBook(bookId: string): Promise<void> {
  const tables = [db.books, db.files, db.annotations, db.ink, db.chats, db.chatTombs, db.ocr, db.vectors, db.tombstones, db.syncMeta, db.texts, db.reflows, db.tocs, db.xray];
  await db.transaction('rw', tables, async () => {
    await db.books.delete(bookId);
    await db.files.delete(bookId);
    await db.texts.delete(bookId);
    await db.reflows.delete(bookId);
    await db.tocs.delete(bookId);
    await db.xray.delete(bookId);
    await db.annotations.where('bookId').equals(bookId).delete();
    await db.ink.where('bookId').equals(bookId).delete();
    const chats = await db.chats.where('bookId').equals(bookId).primaryKeys();
    await db.chats.bulkDelete(chats);
    await db.chatTombs.bulkPut(chats.map((id) => ({ id, deletedAt: Date.now() })));
    await db.ocr.where('bookId').equals(bookId).delete();
    await db.vectors.delete(bookId);
    await db.syncMeta.delete(bookId);
    // One tombstone for the whole book replaces the ones of its annotations.
    await db.tombstones.where('bookId').equals(bookId).delete();
    await db.tombstones.put({ id: `b:${bookId}`, kind: 'book', bookId, deletedAt: Date.now() });
  });
}

/** Deletes a conversation with an agent and remembers the deletion for sync. */
export async function deleteChat(id: string): Promise<void> {
  await db.transaction('rw', db.chats, db.chatTombs, async () => {
    await db.chats.delete(id);
    await db.chatTombs.put({ id, deletedAt: Date.now() });
  });
}

/** Deletes a highlight, note or bookmark and remembers the deletion for sync. */
export async function deleteAnnotation(annotation: Pick<Annotation, 'id' | 'bookId'>): Promise<void> {
  await db.transaction('rw', db.annotations, db.tombstones, async () => {
    await db.annotations.delete(annotation.id);
    await db.tombstones.put({ id: `a:${annotation.id}`, kind: 'annotation', bookId: annotation.bookId, deletedAt: Date.now() });
  });
}

export const inkId = (bookId: string, page: number) => `${bookId}:${page}`;
export const chatId = (bookId: string, agentId: string) => `${bookId}:${agentId}`;
