import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpen, Brain, Cloud, CloudDownload, Download, LoaderCircle, Moon, Palette, Pencil, Plus, RefreshCw, Search, Settings, Sparkles, Sun, Trash2, Upload, X } from 'lucide-react';
import { db, deleteBook } from '../db';
import { LIBRARY_CHAT } from '../lib/chats';
import { takeJump } from '../lib/jump';
import { importBooks } from '../lib/library';
import { autoSync, isBookInStorage, removeLocalCopy, syncConfig, useSyncStatus } from '../lib/sync';
import { cx, formatBytes } from '../lib/utils';
import { updateSettings, useSettings, type LibrarySort, type Theme } from '../settings';
import type { BookRecord } from '../types';
import { AiSettings } from './AiSettings';
import { BookInfoDialog } from './BookInfoDialog';
import { forgetSearch, LibrarySearch, searchWasOpen } from './LibrarySearch';
import { SyncDialog } from './SyncDialog';

const LibraryAssistant = lazy(() => import('./LibraryAssistant').then((m) => ({ default: m.LibraryAssistant })));

// Phones and tablets do not know the DjVu (and sometimes EPUB) file types and grey such files out
// in the picker when a filter is set, so there the filter is dropped; the format is checked on import anyway.
const ACCEPT = matchMedia('(pointer: coarse)').matches ? undefined : '.epub,.pdf,.djvu,.djv,.fb2,.fbz,.zip,application/epub+zip,application/pdf,image/vnd.djvu';
/** Stands for "on no shelf" among the shelf filters; no shelf can be named this. */
const NO_SHELF = '\u0000';
const SORTS: [LibrarySort, string][] = [
  ['recent', 'Нещодавні'],
  ['title', 'За назвою'],
  ['author', 'За автором'],
  ['progress', 'За прогресом'],
  ['added', 'Нещодавно додані'],
];
const byName = (a: string, b: string) => a.localeCompare(b, 'uk', { sensitivity: 'base', numeric: true });
const ORDER: Record<LibrarySort, (a: BookRecord, b: BookRecord) => number> = {
  recent: (a, b) => Math.max(b.lastOpenedAt, b.addedAt) - Math.max(a.lastOpenedAt, a.addedAt),
  title: (a, b) => byName(a.title, b.title),
  // Books without an author go last.
  author: (a, b) => Number(!a.author) - Number(!b.author) || byName(a.author, b.author) || byName(a.title, b.title),
  progress: (a, b) => b.progress - a.progress || byName(a.title, b.title),
  added: (a, b) => b.addedAt - a.addedAt,
};
const NEXT_THEME: Record<Theme, Theme> = { light: 'sepia', sepia: 'dark', dark: 'light' };
const THEME_ICON = { light: Sun, sepia: Palette, dark: Moon };
const THEME_NAME: Record<Theme, string> = { light: 'світла', sepia: 'сепія', dark: 'темна' };

interface Props {
  onOpen(bookId: string): void;
  /** Present when the browser offers to install the app. */
  onInstall?: () => void;
}

export function Library({ onOpen, onInstall }: Props) {
  const settings = useSettings();
  const books = useLiveQuery(() => db.books.toArray(), []);
  // Cards whose time has come: shown as a badge on the way into the study room.
  const dueCount = useLiveQuery(() => db.cards.where('due').belowOrEqual(Date.now()).filter((c) => c.state !== 'new').count(), []) ?? 0;
  const [filter, setFilter] = useState('');
  const [importing, setImporting] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [aiSettings, setAiSettings] = useState(false);
  const [syncDialog, setSyncDialog] = useState(false);
  // The assistant that works with the whole library; a saved conversation may be asked for from a book's history.
  const [assistant, setAssistant] = useState<{ thread: string | null } | null>(() => {
    const jump = takeJump(LIBRARY_CHAT);
    return jump ? { thread: jump.thread ?? null } : null;
  });
  // Back from a book that was opened from the search: the search is still there, with its results.
  const [searching, setSearching] = useState(searchWasOpen);
  useEffect(forgetSearch, []);
  /** A book that is also in the sync storage: removing it needs a choice of where from. */
  const [removing, setRemoving] = useState<BookRecord | null>(null);
  const [editing, setEditing] = useState<BookRecord | null>(null);
  /** The shelf being looked at; null shows every book. */
  const [shelf, setShelf] = useState<string | null>(null);
  const sync = useSyncStatus();
  const syncReady = Boolean(syncConfig(settings));
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  /** Shelves with how many books stand on each, and how many stand on none. */
  const shelves = useMemo(() => {
    const count = new Map<string, number>();
    let loose = 0;
    for (const b of books ?? []) {
      if (!b.tags?.length) loose++;
      for (const t of b.tags ?? []) count.set(t, (count.get(t) ?? 0) + 1);
    }
    return { list: [...count].sort((a, b) => byName(a[0], b[0])), loose };
  }, [books]);
  // A shelf that has just lost its last book is no longer there to look at.
  const onShelf = shelf === NO_SHELF || shelves.list.some(([name]) => name === shelf) ? shelf : null;

  const shown = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase();
    return (books ?? [])
      .filter((b) => (onShelf === null ? true : onShelf === NO_SHELF ? !b.tags?.length : b.tags?.includes(onShelf)))
      .filter((b) => !q || b.title.toLocaleLowerCase().includes(q) || b.author.toLocaleLowerCase().includes(q) || b.tags?.some((t) => t.toLocaleLowerCase().includes(q)))
      .sort(ORDER[settings.librarySort] ?? ORDER.recent);
  }, [books, filter, onShelf, settings.librarySort]);

  const add = async (files: File[]) => {
    if (!files.length) return;
    setErrors([]);
    setImporting(files.length);
    try {
      const result = await importBooks(files);
      setErrors(result.errors);
      autoSync(true);
    } finally {
      setImporting(0);
    }
  };

  const remove = async (book: BookRecord) => {
    if (await isBookInStorage(book.id)) return setRemoving(book);
    if (confirm(`Видалити «${book.title}» з бібліотеки разом із нотатками, малюнками та розмовами з AI?`)) await deleteBook(book.id);
  };

  const syncTitle = !syncReady
    ? 'Синхронізація між пристроями: не налаштовано'
    : sync.running
      ? `Синхронізація: ${sync.step}`
      : sync.error
        ? `Синхронізація не вдалася: ${sync.error}`
        : 'Синхронізація між пристроями';

  const ThemeIcon = THEME_ICON[settings.theme];
  const empty = books !== undefined && books.length === 0;

  // Ctrl+F in the library searches inside every book.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f' || !books?.length) return;
      e.preventDefault();
      setSearching(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [books?.length]);

  return (
    <div
      className={cx('library', dragging && 'dragging')}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void add(Array.from(e.dataTransfer.files));
      }}
    >
      <header className="library-bar">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width={32} height={32} />
          <div>
            <strong>Закладка</strong>
            <small className="muted">читалка з AI-агентами</small>
          </div>
        </div>
        {!empty && (
          <label className="library-search">
            <Search size={16} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Пошук у бібліотеці" aria-label="Пошук у бібліотеці" />
            {filter && (
              <button className="icon-btn" onClick={() => setFilter('')} title="Очистити">
                <X size={14} />
              </button>
            )}
          </label>
        )}
        <span className="spacer" />
        {onInstall && (
          <button className="btn" onClick={onInstall} title="Встановити як застосунок">
            <Download size={16} /> <span className="hide-narrow">Встановити</span>
          </button>
        )}
        {!empty && (
          <button className="icon-btn" onClick={() => setSearching(true)} title="Пошук у всіх книгах (Ctrl+F)" aria-label="Пошук у всіх книгах">
            <Search size={18} />
          </button>
        )}
        <button className={cx('icon-btn', assistant && 'active')} onClick={() => setAssistant(assistant ? null : { thread: null })} title="AI-помічник: пошук у всіх книгах і налаштування" aria-label="AI-помічник">
          <Sparkles size={18} />
        </button>
        <button
          className="icon-btn study-btn"
          onClick={() => {
            location.hash = '#/study';
          }}
          title={dueCount ? `Навчання: ${dueCount} до повторення` : 'Навчання: картки, повторення, палаци пам’яті'}
          aria-label="Навчання"
        >
          <Brain size={18} />
          {dueCount > 0 && <span className="count-badge">{dueCount > 99 ? '99+' : dueCount}</span>}
        </button>
        <button
          className="icon-btn"
          onClick={() => updateSettings({ theme: NEXT_THEME[settings.theme] })}
          title={`Тема: ${THEME_NAME[settings.theme]}. Натисніть, щоб змінити`}
        >
          <ThemeIcon size={18} />
        </button>
        <button className={cx('icon-btn sync-btn', syncReady && !sync.running && sync.error && 'has-error')} onClick={() => setSyncDialog(true)} title={syncTitle} aria-label={syncTitle}>
          {sync.running ? <RefreshCw size={18} className="spin" /> : <Cloud size={18} />}
        </button>
        <button className="icon-btn" onClick={() => setAiSettings(true)} title="Налаштування AI">
          <Settings size={18} />
        </button>
        <button className="btn primary add-book" onClick={() => fileRef.current?.click()} disabled={importing > 0} title="Додати книгу" aria-label="Додати книгу">
          {importing > 0 ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}
          <span className="hide-narrow">Додати книгу</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            void add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </header>

      {errors.length > 0 && (
        <div className="notice error" role="alert">
          <div>
            {errors.map((err, i) => (
              <p key={i}>{err}</p>
            ))}
          </div>
          <button className="icon-btn" onClick={() => setErrors([])} title="Закрити">
            <X size={16} />
          </button>
        </div>
      )}
      {importing > 0 && (
        <div className="notice">
          <LoaderCircle size={16} className="spin" /> Додаю {importing > 1 ? `${importing} файли(ів)` : 'книгу'}…
        </div>
      )}

      <main className="library-main">
        {empty ? (
          <div className="empty-library">
            <Upload size={40} />
            <h1>Додайте першу книгу</h1>
            <p className="muted">
              Перетягніть сюди файли EPUB, PDF, DjVu або FB2 чи виберіть їх на пристрої. Книги зберігаються лише у вашому браузері й доступні без інтернету.
            </p>
            <button className="btn primary large" onClick={() => fileRef.current?.click()}>
              <Plus size={18} /> Вибрати файли
            </button>
          </div>
        ) : (
          <>
            <div className="library-tools">
              <div className="shelf-chips" role="tablist" aria-label="Полиці">
                <button role="tab" aria-selected={onShelf === null} className={cx('chip', onShelf === null && 'active')} onClick={() => setShelf(null)}>
                  Усі · {books?.length ?? 0}
                </button>
                {shelves.list.map(([name, count]) => (
                  <button key={name} role="tab" aria-selected={onShelf === name} className={cx('chip', onShelf === name && 'active')} onClick={() => setShelf(name)}>
                    {name} · {count}
                  </button>
                ))}
                {shelves.list.length > 0 && shelves.loose > 0 && (
                  <button role="tab" aria-selected={onShelf === NO_SHELF} className={cx('chip', onShelf === NO_SHELF && 'active')} onClick={() => setShelf(NO_SHELF)}>
                    Без полиці · {shelves.loose}
                  </button>
                )}
              </div>
              <select className="library-sort" value={settings.librarySort} onChange={(e) => updateSettings({ librarySort: e.target.value as LibrarySort })} aria-label="Сортування" title="Сортування">
                {SORTS.map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="book-grid">
              {shown.map((book) => (
                <BookCard key={book.id} book={book} onOpen={() => onOpen(book.id)} onRemove={() => void remove(book)} onEdit={() => setEditing(book)} />
              ))}
            </div>
            {books && shown.length === 0 && <p className="muted center">{filter.trim() ? `Нічого не знайдено за запитом «${filter}».` : 'На цій полиці ще немає книг.'}</p>}
          </>
        )}
      </main>

      {dragging && (
        <div className="drop-overlay">
          <Upload size={36} />
          <span>Відпустіть, щоб додати до бібліотеки</span>
        </div>
      )}
      {searching && books && (
        <LibrarySearch
          books={books}
          onOpen={onOpen}
          onClose={() => setSearching(false)}
          onOpenAiSettings={() => setAiSettings(true)}
          onOpenAssistant={(thread) => {
            setSearching(false);
            setAssistant({ thread });
          }}
        />
      )}
      {assistant && (
        <Suspense fallback={null}>
          <LibraryAssistant thread={assistant.thread} onOpenBook={onOpen} onOpenSettings={() => setAiSettings(true)} onClose={() => setAssistant(null)} />
        </Suspense>
      )}
      {aiSettings && <AiSettings onClose={() => setAiSettings(false)} />}
      {syncDialog && <SyncDialog onClose={() => setSyncDialog(false)} />}
      {removing && <RemoveDialog book={removing} onClose={() => setRemoving(null)} />}
      {editing && <BookInfoDialog book={editing} shelves={shelves.list.map(([name]) => name)} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Removing a synced book: only its file from this device, or the book everywhere. */
function RemoveDialog({ book, onClose }: { book: BookRecord; onClose(): void }) {
  const run = async (action: () => Promise<void>) => {
    await action();
    autoSync(true);
    onClose();
  };
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Видалення книги" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="modal-header">
          <h2>Видалити «{book.title}»?</h2>
          <button className="icon-btn" onClick={onClose} title="Закрити">
            <X size={18} />
          </button>
        </header>
        {!book.cloudOnly && (
          <div className="choice">
            <button className="btn" onClick={() => void run(() => removeLocalCopy(book.id))}>
              Прибрати файл із цього пристрою
            </button>
            <small className="muted">
              Звільнить {formatBytes(book.size)}. Книга з нотатками залишиться в бібліотеці й завантажиться зі сховища, коли ви її відкриєте.
            </small>
          </div>
        )}
        <div className="choice">
          <button className="btn danger" onClick={() => void run(() => deleteBook(book.id))}>
            Видалити на всіх пристроях
          </button>
          <small className="muted">Книга, нотатки й малюнки зникнуть зі сховища, а з інших пристроїв — після їхньої наступної синхронізації.</small>
        </div>
        <footer className="modal-footer">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Скасувати
          </button>
        </footer>
      </div>
    </div>
  );
}

function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

function BookCard({ book, onOpen, onRemove, onEdit }: { book: BookRecord; onOpen(): void; onRemove(): void; onEdit(): void }) {
  const cover = useObjectUrl(book.cover);
  const percent = Math.round(book.progress * 100);
  return (
    <article className="book-card">
      <button className="book-open" onClick={onOpen} title={`Читати «${book.title}»`}>
        <div className="book-cover">
          {cover ? (
            <img src={cover} alt="" loading="lazy" />
          ) : (
            <div className="cover-fallback">
              <BookOpen size={28} />
              <span>{book.title}</span>
            </div>
          )}
          <span className="format-badge">{book.format.toUpperCase()}</span>
          {book.cloudOnly && (
            <span className="cloud-badge" title="Файл у сховищі: завантажиться, коли ви відкриєте книгу">
              <CloudDownload size={14} />
            </span>
          )}
          {book.lastOpenedAt > 0 && (
            <div className="cover-progress" aria-label={`Прочитано ${percent}%`}>
              <div style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
        <strong className="book-title">{book.title}</strong>
        <span className="book-meta muted">
          {book.author || 'Автор невідомий'}
          {book.lastOpenedAt > 0 ? ` · ${percent}%` : ` · ${formatBytes(book.size)}`}
        </span>
      </button>
      <button className="icon-btn book-remove book-edit" onClick={onEdit} title="Назва, автор, полиці" aria-label="Назва, автор, полиці">
        <Pencil size={14} />
      </button>
      <button className="icon-btn book-remove" onClick={onRemove} title="Видалити з бібліотеки">
        <Trash2 size={15} />
      </button>
    </article>
  );
}
