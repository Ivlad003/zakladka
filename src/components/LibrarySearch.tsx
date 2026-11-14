import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, LoaderCircle, Search, Sparkles, Square, X } from 'lucide-react';
import { setJump } from '../lib/jump';
import {
  ensureBookText,
  indexBooks,
  indexedBooks,
  isAborted,
  searchBookText,
  searchByMeaning,
  type BookHits,
  type IndexAllProgress,
  type MeaningHit,
  type TextResult,
} from '../lib/library-search';
import { describeEmbedError, getEmbedder } from '../lib/semantic';
import { cx, pluralUk, truncate } from '../lib/utils';
import { getSettings, useSettings } from '../settings';
import type { BookRecord, SearchHit } from '../types';
import { LIBRARY_CHAT } from '../lib/chats';
import { ChatHistory } from './ChatHistory';

interface Props {
  books: BookRecord[];
  onOpen(bookId: string): void;
  onClose(): void;
  onOpenAiSettings(): void;
  /** Opens the library's own assistant on a saved conversation. */
  onOpenAssistant(threadId: string): void;
}

type Mode = 'exact' | 'semantic' | 'chats';
// Remembered while the app is open: coming back from a book, the search is where it was left.
let lastMode: Mode = 'exact';
let lastQuery = '';
let resume = false;

/** True when the last book was opened from this search: the library then reopens it on return. */
export const searchWasOpen = () => resume;
export const forgetSearch = () => {
  resume = false;
};

const FORMAT = { epub: 'EPUB', pdf: 'PDF', djvu: 'DjVu' };
const SHOWN_PER_BOOK = 5;

interface ExactResult {
  query: string;
  groups: BookHits[];
  /** Books whose title or author contains the query. */
  titles: BookRecord[];
  /** Books that could not be searched: the file is not on this device / the pages have no text. */
  noFile: number;
  noText: number;
}

/** Search across the whole library: every book, every format, by exact words or by meaning. */
export function LibrarySearch({ books, onOpen, onClose, onOpenAiSettings, onOpenAssistant }: Props) {
  const settings = useSettings();
  const [mode, setModeState] = useState<Mode>(lastMode);
  const [value, setValue] = useState(lastQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const setMode = (m: Mode) => {
    lastMode = m;
    setModeState(m);
  };
  const query = value.trim();

  useEffect(() => {
    lastQuery = value;
  }, [value]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // ---- The text of every book, read once and then kept ----
  const textsRef = useRef(new Map<string, TextResult | 'failed'>());
  const [reading, setReading] = useState<{ done: number; total: number; title: string } | null>(null);
  const [prepared, setPrepared] = useState(false);
  const bookKey = books.map((b) => b.id).join(',');

  useEffect(() => {
    const controller = new AbortController();
    setPrepared(false);
    (async () => {
      for (let i = 0; i < books.length; i++) {
        const book = books[i];
        if (!textsRef.current.has(book.id) || textsRef.current.get(book.id) === 'no-file') {
          setReading({ done: i, total: books.length, title: book.title });
          try {
            textsRef.current.set(book.id, await ensureBookText(book, controller.signal));
          } catch (err) {
            if (isAborted(err) || controller.signal.aborted) return;
            console.error(`Не вдалося прочитати текст книги «${book.title}»`, err);
            textsRef.current.set(book.id, 'failed');
          }
        }
        if (controller.signal.aborted) return;
      }
      setReading(null);
      setPrepared(true);
    })();
    return () => controller.abort();
    // The list of books changes identity on every library update; only its membership matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  // ---- Exact search: as you type, once the texts are ready ----
  const [exact, setExact] = useState<ExactResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (mode !== 'exact') return;
    if (query.length < 2 || !prepared) {
      setExact(null);
      return;
    }
    const timer = setTimeout(() => {
      const groups: BookHits[] = [];
      let noFile = 0;
      let noText = 0;
      for (const book of books) {
        const text = textsRef.current.get(book.id);
        if (!text || text === 'no-file' || text === 'failed') {
          noFile++;
          continue;
        }
        if (!text.units.some((u) => u.trim())) {
          noText++;
          continue;
        }
        const found = searchBookText(book, text, query);
        if (found.total) groups.push(found);
      }
      groups.sort((a, b) => b.total - a.total);
      const lower = query.toLocaleLowerCase();
      const titles = books.filter((b) => b.title.toLocaleLowerCase().includes(lower) || b.author.toLocaleLowerCase().includes(lower));
      setExpanded(new Set());
      setExact({ query, groups, titles, noFile, noText });
    }, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode, prepared, bookKey]);

  // ---- Search by meaning ----
  const embedder = useMemo(() => getEmbedder(settings), [settings]);
  const embedderId = 'id' in embedder ? embedder.id : null;
  const [indexed, setIndexed] = useState<Set<string> | null>(null);
  const [job, setJob] = useState<{ progress: IndexAllProgress | null; running: boolean; error: string | null; skipped: string[] }>({
    progress: null,
    running: false,
    error: null,
    skipped: [],
  });
  const [meaning, setMeaning] = useState<{ query: string; busy: boolean; hits: MeaningHit[]; error: string | null } | null>(null);
  const jobRef = useRef<AbortController | null>(null);
  const meaningRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    setIndexed(null);
    if (embedderId) void indexedBooks(embedderId).then((set) => alive && setIndexed(set));
    return () => {
      alive = false;
    };
  }, [embedderId, bookKey]);

  useEffect(
    () => () => {
      jobRef.current?.abort();
      meaningRef.current?.abort();
    },
    [],
  );

  const unindexed = useMemo(() => books.filter((b) => indexed && !indexed.has(b.id)), [books, indexed]);
  const indexedCount = indexed ? books.filter((b) => indexed.has(b.id)).length : 0;

  const indexAll = async () => {
    if (!('id' in embedder) || jobRef.current) return;
    const controller = new AbortController();
    jobRef.current = controller;
    setJob({ progress: null, running: true, error: null, skipped: [] });
    try {
      const { skipped } = await indexBooks(unindexed, embedder, controller.signal, (progress) => setJob((j) => ({ ...j, progress })));
      setJob({ progress: null, running: false, error: null, skipped: skipped.map((b) => b.title) });
    } catch (err) {
      setJob({ progress: null, running: false, error: isAborted(err) || controller.signal.aborted ? null : describeEmbedError(err, getSettings()), skipped: [] });
    } finally {
      jobRef.current = null;
      setIndexed(await indexedBooks(embedder.id));
    }
  };

  const runMeaning = async () => {
    if (!('id' in embedder) || !query || !indexedCount) return;
    meaningRef.current?.abort();
    const controller = new AbortController();
    meaningRef.current = controller;
    setMeaning({ query, busy: true, hits: [], error: null });
    try {
      const hits = await searchByMeaning(books, embedder, query, 30, controller.signal);
      if (!controller.signal.aborted) setMeaning({ query, busy: false, hits, error: null });
    } catch (err) {
      if (!controller.signal.aborted && !isAborted(err)) setMeaning({ query, busy: false, hits: [], error: describeEmbedError(err, getSettings()) });
    }
  };

  // ---- Opening what was found ----
  const openBook = (bookId: string) => {
    resume = true;
    onOpen(bookId);
  };
  const openHit = (book: BookRecord, hit: SearchHit) => {
    setJump({ bookId: book.id, unit: hit.unit, query: exact?.query ?? query, matchIndex: hit.matchIndex });
    openBook(book.id);
  };
  const openPassage = (hit: MeaningHit) => {
    setJump({ bookId: hit.book.id, unit: hit.unit, passage: hit.text });
    openBook(hit.book.id);
  };

  const totalHits = exact?.groups.reduce((sum, g) => sum + g.total, 0) ?? 0;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal lib-search" role="dialog" aria-label="Пошук у всіх книгах" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-header">
          <h2>Пошук у всіх книгах</h2>
          <button className="icon-btn" onClick={onClose} title="Закрити">
            <X size={18} />
          </button>
        </div>

        <div className="segmented wide" role="tablist" aria-label="Вид пошуку">
          <button role="tab" aria-selected={mode === 'exact'} className={cx(mode === 'exact' && 'active')} onClick={() => setMode('exact')} title="Шукає слова й фрази точно так, як їх написано">
            Точний
          </button>
          <button role="tab" aria-selected={mode === 'semantic'} className={cx(mode === 'semantic' && 'active')} onClick={() => setMode('semantic')} title="Шукає фрагменти за змістом, навіть якщо в них інші слова">
            Смисловий
          </button>
          <button role="tab" aria-selected={mode === 'chats'} className={cx(mode === 'chats' && 'active')} onClick={() => setMode('chats')} title="Шукає в розмовах з AI-агентами за всіма книгами">
            Розмови
          </button>
        </div>

        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === 'semantic') void runMeaning();
            // On a phone, Enter also puts the keyboard away so the results can be seen.
            else inputRef.current?.blur();
          }}
        >
          <Search size={16} className="search-icon" />
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={mode === 'exact' ? 'Слово або фраза…' : mode === 'chats' ? 'Пошук у розмовах з AI…' : 'Запитання або опис того, що шукаєте…'}
            aria-label="Пошук у всіх книгах"
            enterKeyHint="search"
          />
          {value && (
            <button
              type="button"
              className="icon-btn"
              title="Очистити"
              onClick={() => {
                setValue('');
                setMeaning(null);
                inputRef.current?.focus();
              }}
            >
              <X size={16} />
            </button>
          )}
        </form>

        <div className="lib-results">
          {mode === 'chats' ? (
            <ChatHistory
              query={value}
              onOpen={(thread) => {
                if (thread.bookId === LIBRARY_CHAT) return onOpenAssistant(thread.id);
                setJump({ bookId: thread.bookId, thread: thread.id });
                openBook(thread.bookId);
              }}
            />
          ) : mode === 'exact' ? (
            <>
              {reading && (
                <div className="hint">
                  <div className="search-progress">
                    <div className="bar" style={{ width: `${Math.round((reading.done / Math.max(1, reading.total)) * 100)}%` }} />
                  </div>
                  <p>
                    <LoaderCircle size={13} className="spin" /> Читаю текст книг для пошуку: {reading.done + 1} з {reading.total} — «{truncate(reading.title, 40)}». Це потрібно лише
                    раз для кожної книги.
                  </p>
                </div>
              )}
              {!reading && !exact && (
                <p className="panel-empty">
                  Шукає в тексті всіх книг бібліотеки — EPUB, PDF і DjVu разом. Введіть щонайменше дві літери. У сканах шукає там, де текст уже розпізнано (OCR).
                </p>
              )}
              {exact && (
                <>
                  <p className="panel-meta">
                    {totalHits
                      ? `${totalHits} ${pluralUk(totalHits, 'збіг', 'збіги', 'збігів')} у ${exact.groups.length} ${pluralUk(exact.groups.length, 'книзі', 'книгах', 'книгах')}`
                      : `У тексті книг нічого не знайдено за запитом «${exact.query}».`}
                    {exact.noFile > 0 && ` Не переглянуто (файл ще не завантажено на цей пристрій): ${exact.noFile}.`}
                    {exact.noText > 0 && ` Без тексту (скани без розпізнавання): ${exact.noText}.`}
                  </p>
                  {exact.titles.length > 0 && (
                    <section className="lib-group">
                      <h3 className="lib-group-title">Назви та автори</h3>
                      <ul>
                        {exact.titles.map((book) => (
                          <li key={book.id}>
                            <button className="hit lib-book-row" onClick={() => openBook(book.id)}>
                              <BookOpen size={15} />
                              <span className="hit-text">
                                <strong>{book.title}</strong>
                                {book.author && <span className="muted"> · {book.author}</span>}
                              </span>
                              <span className="lib-format">{FORMAT[book.format]}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {exact.groups.map(({ book, hits, total }) => {
                    const open = expanded.has(book.id);
                    const shown = open ? hits : hits.slice(0, SHOWN_PER_BOOK);
                    return (
                      <section className="lib-group" key={book.id}>
                        <h3 className="lib-group-title">
                          <span className="lib-format">{FORMAT[book.format]}</span>
                          <span className="lib-group-name">{book.title}</span>
                          <span className="muted">{total}</span>
                        </h3>
                        <ul>
                          {shown.map((hit, i) => (
                            <li key={i}>
                              <button className="hit" onClick={() => openHit(book, hit)}>
                                <span className="hit-label">{hit.label}</span>
                                <span className="hit-text">
                                  {hit.pre}
                                  <mark>{hit.match}</mark>
                                  {hit.post}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                        {!open && hits.length > SHOWN_PER_BOOK && (
                          <button className="link lib-more" onClick={() => setExpanded((set) => new Set(set).add(book.id))}>
                            Показати ще {Math.min(hits.length, total) - SHOWN_PER_BOOK}
                          </button>
                        )}
                        {open && total > hits.length && <p className="panel-meta">Показано перші {hits.length}; решту видно в пошуку всередині книги.</p>}
                      </section>
                    );
                  })}
                </>
              )}
            </>
          ) : (
            <>
              {'missing' in embedder ? (
                <div className="hint">
                  <p className="error-text">{embedder.missing}</p>
                  <button className="btn small" onClick={onOpenAiSettings}>
                    Налаштування AI
                  </button>
                </div>
              ) : job.running ? (
                <div className="hint">
                  <div className="search-progress">
                    <div className="bar" style={{ width: `${job.progress?.step?.total ? Math.round((job.progress.step.done / job.progress.step.total) * 100) : 0}%` }} />
                  </div>
                  <p>
                    <LoaderCircle size={13} className="spin" />{' '}
                    {job.progress ? `Книга ${job.progress.book} з ${job.progress.books}: «${truncate(job.progress.title, 40)}». ${job.progress.step?.status ?? ''}` : 'Готуюся…'}
                    {job.progress?.step?.total ? ` ${job.progress.step.done} з ${job.progress.step.total}` : ''}
                  </p>
                  <button className="btn small" onClick={() => jobRef.current?.abort()}>
                    <Square size={13} /> Зупинити
                  </button>
                </div>
              ) : (
                <div className="hint">
                  <p>
                    Знаходить фрагменти за змістом, навіть якщо в них інші слова, — у всіх книгах одразу. Шукає в проіндексованих книгах:{' '}
                    <strong>
                      {indexed ? indexedCount : '…'} з {books.length}
                    </strong>
                    . Ембединги: {embedder.label}.
                  </p>
                  {unindexed.length > 0 && (
                    <button className="btn small" onClick={() => void indexAll()}>
                      <Sparkles size={14} /> Проіндексувати решту ({unindexed.length})
                    </button>
                  )}
                  {job.error && <p className="error-text">{job.error}</p>}
                  {job.skipped.length > 0 && (
                    <p className="muted">
                      Без тексту або без файла на цьому пристрої: {job.skipped.map((t) => `«${truncate(t, 30)}»`).join(', ')}. Для сканів спершу розпізнайте текст (OCR).
                    </p>
                  )}
                </div>
              )}

              {meaning?.busy && (
                <p className="panel-meta">
                  <LoaderCircle size={13} className="spin" /> Шукаю за змістом…
                </p>
              )}
              {meaning?.error && <p className="error-text">{meaning.error}</p>}
              {meaning && !meaning.busy && !meaning.error && (
                <p className="panel-meta">{meaning.hits.length ? `Найближчі за змістом фрагменти до «${truncate(meaning.query, 60)}»` : 'Нічого схожого не знайдено.'}</p>
              )}
              {!meaning && indexedCount > 0 && !job.running && <p className="panel-empty">Введіть запитання й натисніть Enter.</p>}
              <ul>
                {meaning?.hits.map((hit, i) => (
                  <li key={i}>
                    <button className="hit" onClick={() => openPassage(hit)}>
                      <span className="hit-label">
                        <span className="lib-format">{FORMAT[hit.book.format]}</span> {truncate(hit.book.title, 48)} · {hit.label}
                        <span className="score">{Math.round(hit.score * 100)}%</span>
                      </span>
                      <span className="hit-text">{truncate(hit.text, 320)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
