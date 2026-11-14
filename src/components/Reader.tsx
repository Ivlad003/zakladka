import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  BookOpenCheck,
  Brain,
  ChevronLeft,
  ChevronRight,
  Copy,
  Ellipsis,
  Eraser,
  Highlighter,
  Languages,
  Layers,
  List,
  LoaderCircle,
  Maximize,
  MessageSquare,
  MessageSquarePlus,
  Minimize,
  Pencil,
  ScanText,
  Users,
  ImageIcon,
  Search,
  Sparkles,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  X,
  type LucideIcon,
  Volume2,
} from 'lucide-react';
import type { AgentContext, SemanticHit } from '../ai/tools';
import { db, deleteAnnotation as forgetAnnotation, inkId } from '../db';
import { openEngine } from '../engines';
import { OcrLayeredEngine } from '../engines/ocr-engine';
import type { Engine } from '../engines/types';
import { quickFill } from '../ai/quick';
import { isTouchDevice, useMediaQuery, type TapZone } from '../lib/gestures';
import { takeJump } from '../lib/jump';
import { durationLabel, paceOf, startTracking, useReadingLog, type Tracker } from '../lib/stats';
import type { AloudSource } from '../lib/read-aloud';
import { exportNotesMarkdown, sortAnnotations } from '../lib/notes';
import { clearOcr, runOcr, type OcrProgress } from '../lib/ocr';
import { studyApiFor, topicForBook, type CardDraft } from '../lib/study';
import { buildIndex, describeEmbedError, getEmbedder, searchIndex, type BuildProgress } from '../lib/semantic';
import { downloadBookFile } from '../lib/sync';
import { clamp, cx, isTypingTarget, truncate, uid } from '../lib/utils';
import { getSettings, updateSettings, useSettings } from '../settings';
import type { Annotation, DrawState, DrawTool, HighlightColor, SearchHit, SelectionInfo, Stroke, TocItem, VectorIndex } from '../types';
import type { AiRequest } from './AiPanel';
import { EpubView, type EpubPosition, type EpubViewApi } from './EpubView';
import { NoteEditor } from './NoteEditor';
import { OcrDialog } from './OcrDialog';
import { ReadAloudBar } from './ReadAloudBar';
import { DictionaryCard } from './DictionaryCard';
import { isWord } from '../lib/dictionary';

const XrayPanel = lazy(() => import('./XrayPanel').then((m) => ({ default: m.XrayPanel })));
const QuoteCard = lazy(() => import('./QuoteCard').then((m) => ({ default: m.QuoteCard })));
import { PagedView, type FixedViewApi } from './PagedView';
import { ColorDots, Popup } from './Popup';
import { AiSettings } from './AiSettings';
import { CardEditor } from './CardEditor';
import { SwipeZones } from './SwipeZones';
import { GestureDebug, TurnButtons } from './TurnButtons';
import { ViewSettings } from './Settings';
import { importBooks } from '../lib/library';
import type { EpubEngineLike } from '../engines/types';
import type { ReflowProgress } from '../engines/reflow';
import type { MadeTocState } from './SidePanel';
import { SidePanel, type SearchState, type SemanticState, type SideTab } from './SidePanel';

// The AI panel pulls in the Claude SDK and the Markdown renderer; load them only when it is opened.
const AiPanel = lazy(() => import('./AiPanel').then((m) => ({ default: m.AiPanel })));

const NO_ANNOTATIONS: Annotation[] = [];
const NO_SEARCH: SearchState = { query: '', hits: [], busy: false, progress: 0, ranFor: '' };
const NO_SEMANTIC_QUERY = { ranFor: '', busy: false, hits: [] as SemanticHit[], error: null as string | null };
const IDLE_JOB = { running: false, error: null as string | null };
const PEN_COLORS = ['#1f2328', '#d9364a', '#2b6fd6', '#1e9a55', '#f59e0b'];
const TOOL_SIZES: Record<DrawTool, number> = { pen: 2.5, marker: 16, eraser: 0 };

/** Below this width the reader is laid out like a phone app: full-screen page, bars that hide, a tab bar. */
const NARROW = '(max-width: 900px)';
const isNarrow = () => window.matchMedia(NARROW).matches;
const HINT_KEY = 'zakladka:barsHint';

interface Editing {
  annotation: Annotation;
  isNew: boolean;
  /** Highlights on following pages that belong to the same multi-page selection. */
  extra: Annotation[];
}

export function Reader({ bookId, onExit }: { bookId: string; onExit(): void }) {
  const settings = useSettings();
  const book = useLiveQuery(() => db.books.get(bookId), [bookId]);
  const annotations = useLiveQuery(() => db.annotations.where('bookId').equals(bookId).toArray(), [bookId]) ?? NO_ANNOTATIONS;
  const inkRows = useLiveQuery(() => db.ink.where('bookId').equals(bookId).toArray(), [bookId]);
  const ink = useMemo(() => new Map((inkRows ?? []).map((r) => [r.page, r.strokes])), [inkRows]);

  const [engine, setEngine] = useState<Engine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [startPosition, setStartPosition] = useState<string | null>(null);
  /** A newer reading position that sync brought from another device while this book is open. */
  const [remotePosition, setRemotePosition] = useState<{ position: string; progress: number } | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [unit, setUnit] = useState(0);
  const [epubPos, setEpubPos] = useState<EpubPosition | null>(null);
  // The text mode of a PDF/DjVu book: an EPUB made from its pages is on screen instead of the pages.
  const [reflow, setReflow] = useState(false);
  const reflowRef = useRef(false);
  reflowRef.current = reflow;
  const [reflowKey, setReflowKey] = useState(0);
  const [reflowProgress, setReflowProgress] = useState<ReflowProgress | null>(null);
  const [readerNotice, setReaderNotice] = useState<string | null>(null);
  // Reading time and pages for the statistics.
  const trackerRef = useRef<Tracker | null>(null);
  // A table of contents made from the text, for a PDF/DjVu book without one.
  const [madeToc, setMadeToc] = useState<Omit<MadeTocState, 'onBuild'> | null>(null);
  const madeTocAbortRef = useRef<AbortController | null>(null);
  const [locationsReady, setLocationsReady] = useState(false);
  const [scale, setScale] = useState(1);

  const [side, setSide] = useState<SideTab | null>(null);
  // X-Ray (names in the book), opened on its own or on a name from the dictionary card.
  const [xray, setXray] = useState<{ term: string | null } | null>(null);
  const xrayNames = useLiveQuery(async () => new Map(((await db.xray.get(bookId))?.terms ?? []).map((t) => [t.name.toLocaleLowerCase(), t.count])), [bookId]);
  // A quote being turned into a picture.
  const [quoteCard, setQuoteCard] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [viewMenu, setViewMenu] = useState(false);
  const [aiSettings, setAiSettings] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Phone layout: the bars lie over the page and get out of the way while reading.
  const mobile = useMediaQuery(NARROW);
  // Two pages side by side: on a wide screen, or also on a tablet held sideways when asked for.
  const wideScreen = useMediaQuery('(min-width: 1100px)');
  const landscapeTablet = useMediaQuery('(orientation: landscape) and (min-width: 700px)');
  const spreadWanted = settings.spread === 'off' ? false : settings.spread === 'landscape' ? wideScreen || landscapeTablet : wideScreen;
  // The reader's own font, from the database.
  const [customFontUrl, setCustomFontUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (settings.epubFont !== 'custom') return setCustomFontUrl(undefined);
    let url: string | undefined;
    let alive = true;
    void db.assets.get('font').then((asset) => {
      if (!alive || !asset) return;
      url = URL.createObjectURL(asset.data);
      setCustomFontUrl(url);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [settings.epubFont, settings.epubCustomFontName]);
  const typography = useMemo(
    () => ({ align: settings.epubAlign, hyphens: settings.epubHyphens, letterSpacing: settings.epubLetterSpacing, paragraphGap: settings.epubParagraphGap }),
    [settings.epubAlign, settings.epubHyphens, settings.epubLetterSpacing, settings.epubParagraphGap],
  );
  // A footnote opened from the text.
  const [footnote, setFootnote] = useState<{ text: string; href: string } | null>(null);
  const readingLog = useReadingLog();
  const [bars, setBars] = useState(true);
  const [moreMenu, setMoreMenu] = useState(false);
  const [aloudBar, setAloudBar] = useState(false);
  const [barsHint, setBarsHint] = useState(false);

  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [annotationPopup, setAnnotationPopup] = useState<{ id: string; anchor: SelectionInfo['anchor'] } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  /** A study card being written from the selected text. */
  const [cardDraft, setCardDraft] = useState<Partial<CardDraft> | null>(null);
  const [draw, setDraw] = useState<DrawState | null>(null);
  const [search, setSearch] = useState<SearchState>(NO_SEARCH);
  const [activeHit, setActiveHit] = useState<SearchHit | null>(null);
  const [aiRequest, setAiRequest] = useState<AiRequest | null>(null);
  const [aiQuote, setAiQuote] = useState<string | null>(null);
  const [aiThread, setAiThread] = useState<string | null>(null);
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);

  // OCR of scanned pages (PDF/DjVu only).
  const [ocrEngine, setOcrEngine] = useState<OcrLayeredEngine | null>(null);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrJob, setOcrJob] = useState<{ progress: OcrProgress | null; running: boolean; error: string | null }>({ progress: null, ...IDLE_JOB });
  const ocrCount = useLiveQuery(() => db.ocr.where('bookId').equals(bookId).count(), [bookId]) ?? 0;
  const ocrAbortRef = useRef<AbortController | null>(null);

  // Semantic search index of this book.
  const [vectorIndex, setVectorIndex] = useState<VectorIndex | null>(null);
  const vectorIndexRef = useRef<VectorIndex | null>(null);
  vectorIndexRef.current = vectorIndex;
  const [semanticBuild, setSemanticBuild] = useState<{ progress: BuildProgress | null; running: boolean; error: string | null }>({ progress: null, ...IDLE_JOB });
  const [semanticQuery, setSemanticQuery] = useState(NO_SEMANTIC_QUERY);
  const semanticAbortRef = useRef<AbortController | null>(null);

  const fixedRef = useRef<FixedViewApi>(null);
  const epubRef = useRef<EpubViewApi>(null);
  const unitRef = useRef(0);
  unitRef.current = unit;
  const undoRef = useRef<{ page: number; strokeId: string }[]>([]);
  const searchAbortRef = useRef<AbortController | null>(null);
  const pendingSaveRef = useRef<{ position: string; progress: number } | null>(null);
  /** The position this reader last loaded or saved; `undefined` until the book is open. */
  const ownPositionRef = useRef<string | null | undefined>(undefined);
  /** Timestamp of that position; anything newer in the database came from another device. */
  const ownPositionAtRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // ---- Open the book ----
  useEffect(() => {
    let alive = true;
    let opened: Engine | null = null;
    const building = new AbortController();
    (async () => {
      const [record, file] = await Promise.all([db.books.get(bookId), db.files.get(bookId)]);
      if (!record) throw new Error('Книгу не знайдено в бібліотеці.');
      let data = file?.data;
      if (!data) {
        // The book is known from sync, but its file has not been downloaded to this device yet.
        if (!record.cloudOnly) throw new Error('Файл цієї книги зник зі сховища браузера. Додайте книгу ще раз.');
        setDownloading(true);
        data = await downloadBookFile(bookId);
        if (!alive) return;
        setDownloading(false);
      }
      opened = await openEngine(record.format, await data.arrayBuffer());
      if (!alive) return opened.destroy();

      if (opened.kind === 'fixed') {
        // Scanned pages get their text from OCR results saved earlier.
        const layered = new OcrLayeredEngine(opened);
        layered.load(await db.ocr.where('bookId').equals(bookId).toArray());
        opened = layered;
        setOcrEngine(layered);
        if (!(await layered.hasOwnToc())) {
          const { storedAutoToc } = await import('../lib/auto-toc');
          const kept = await storedAutoToc(bookId, layered.ocrCount);
          if (!alive) return;
          if (kept) layered.setMadeToc(kept.items);
          setMadeToc(kept ? { status: kept.items.length ? 'ready' : 'empty', source: kept.source } : { status: 'idle' });
        } else {
          setMadeToc(null);
        }
      }
      // The text mode: the pages laid out again as an EPUB (made once, then kept).
      let reflowOn = false;
      if (opened.kind === 'fixed' && record.reflow) {
        const pages = opened;
        try {
          const { ensureReflow } = await import('../engines/reflow');
          const ocrPages = await db.ocr.where('bookId').equals(bookId).count();
          const epub = await ensureReflow(bookId, { engine: pages, title: record.title, author: record.author }, ocrPages, (p) => alive && setReflowProgress(p), building.signal);
          if (!alive) return;
          const text = await openEngine('epub', await epub.arrayBuffer());
          if (!alive) return text.destroy();
          pages.destroy();
          opened = text;
          reflowOn = true;
          setOcrEngine(null);
        } catch (err) {
          if (!alive || (err instanceof DOMException && err.name === 'AbortError')) return;
          // The pages stay as they are, and the reader is told why.
          setReaderNotice(err instanceof Error ? err.message : String(err));
          void db.books.update(bookId, { reflow: false });
        } finally {
          if (alive) setReflowProgress(null);
        }
      }
      setReflow(reflowOn);
      const index = await db.vectors.get(bookId);
      if (!alive) return;
      setVectorIndex(index ?? null);

      // Read the position again: sync may have brought a newer one while the file was loading.
      const latest = (await db.books.get(bookId)) ?? record;
      if (!alive) return;
      const position = latest.position;
      ownPositionRef.current = position;
      ownPositionAtRef.current = latest.positionAt ?? 0;
      // In the text mode the position is still a page number: it opens at the start of that page.
      const page = clamp(Number(position ?? 0) || 0, 0, opened.unitCount - 1);
      setStartPosition(reflowOn ? ((opened as EpubEngineLike).book.spine.get(page)?.href ?? null) : position);
      setUnit(opened.kind === 'fixed' || reflowOn ? page : 0);
      setEngine(opened);
      void opened.getToc().then((items) => alive && setToc(items));
      if (opened.kind === 'epub' && !reflowOn) {
        void opened.ensureLocations(record.epubLocations).then((json) => {
          if (!alive) return;
          setLocationsReady(true);
          if (json && json !== record.epubLocations) void db.books.update(bookId, { epubLocations: json });
        });
      }
      void db.books.update(bookId, { lastOpenedAt: Date.now() });
    })().catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));

    return () => {
      alive = false;
      building.abort();
      madeTocAbortRef.current?.abort();
      madeTocAbortRef.current = null;
      opened?.destroy();
      searchAbortRef.current?.abort();
      ocrAbortRef.current?.abort();
      semanticAbortRef.current?.abort();
    };
  }, [bookId, reflowKey]);

  // ---- Remember where the reader is ----
  const flushPosition = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    // Merely opening a book reports the place it was opened at; that is not a move worth a new
    // timestamp, or it would override a newer position from another device.
    if (!pending || pending.position === ownPositionRef.current) return;
    ownPositionRef.current = pending.position;
    ownPositionAtRef.current = Date.now();
    void db.books.update(bookId, { ...pending, positionAt: ownPositionAtRef.current });
  }, [bookId]);

  // Sync changed the saved position under an open book: offer to jump there instead of jumping silently.
  useEffect(() => {
    if (!engine || !book?.position || ownPositionRef.current === undefined) return;
    if ((book.positionAt ?? 0) <= ownPositionAtRef.current || book.position === ownPositionRef.current) return;
    setRemotePosition({ position: book.position, progress: book.progress });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, book?.position, book?.positionAt]);

  const dismissRemotePosition = (jump: boolean) => {
    if (!remotePosition) return;
    ownPositionRef.current = remotePosition.position;
    ownPositionAtRef.current = Math.max(ownPositionAtRef.current, book?.positionAt ?? 0);
    if (jump) {
      if (engine?.kind === 'epub' && reflowRef.current) epubRef.current?.goToUnit(Number(remotePosition.position) || 0);
      else if (engine?.kind === 'epub') epubRef.current?.goToCfi(remotePosition.position);
      else fixedRef.current?.goToPage(Number(remotePosition.position) || 0);
    }
    setRemotePosition(null);
  };

  const savePosition = useCallback(
    (position: string, progress: number) => {
      pendingSaveRef.current = { position, progress: clamp(progress, 0, 1) };
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(flushPosition, 400);
    },
    [flushPosition],
  );

  useEffect(() => {
    // A phone may close a hidden app without another word (iOS seldom sends pagehide to a home-screen
    // app): the place is written as soon as the app is out of sight.
    const onHidden = () => document.visibilityState === 'hidden' && flushPosition();
    window.addEventListener('pagehide', flushPosition);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flushPosition);
      document.removeEventListener('visibilitychange', onHidden);
      flushPosition();
    };
  }, [flushPosition]);

  const unitCount = engine?.unitCount ?? 1;

  const onPageChange = useCallback(
    (page: number) => {
      setUnit(page);
      savePosition(String(page), unitCount > 1 ? page / (unitCount - 1) : 1);
      trackerRef.current?.moved(unitCount > 1 ? page / (unitCount - 1) : 1);
    },
    [savePosition, unitCount],
  );

  const onRelocated = useCallback(
    (pos: EpubPosition) => {
      setEpubPos(pos);
      setUnit(pos.unit);
      const progress = reflowRef.current ? (unitCount > 1 ? pos.unit / (unitCount - 1) : 1) : pos.percent;
      // Laid out again at the same place (opened, resized, restyled): nothing to save, no page read.
      if (pos.layout) {
        trackerRef.current?.at(progress);
        return;
      }
      setSelection(null);
      setAnnotationPopup(null);
      // In the text mode a section is a page, and the page number is what is kept.
      if (reflowRef.current) savePosition(String(pos.unit), progress);
      else savePosition(pos.cfi, pos.percent);
      trackerRef.current?.moved(progress);
    },
    [savePosition, unitCount],
  );

  // ---- Labels ----
  const flatToc = useMemo(() => {
    const out: { unit: number; title: string }[] = [];
    const walk = (items: TocItem[]) => {
      for (const item of items) {
        if (item.unit !== undefined) out.push({ unit: item.unit, title: item.title });
        walk(item.children);
      }
    };
    walk(toc);
    return out.sort((a, b) => a.unit - b.unit);
  }, [toc]);

  const chapterTitle = useCallback(
    (u: number): string | undefined => {
      if (engine?.kind === 'epub') return engine.titleForUnit(u);
      let title: string | undefined;
      for (const entry of flatToc) {
        if (entry.unit > u) break;
        title = entry.title;
      }
      return title;
    },
    [engine, flatToc],
  );

  const positionLabel = useCallback(
    (u: number) => (engine?.kind === 'epub' && !reflow ? (chapterTitle(u) ?? `Розділ ${u + 1}`) : `стор. ${u + 1}`),
    [engine, chapterTitle, reflow],
  );

  // ---- Navigation ----
  const goToUnit = useCallback((u: number) => {
    fixedRef.current?.goToPage(u);
    epubRef.current?.goToUnit(u);
  }, []);
  /** What reading aloud needs from the view: the page on screen and a way to turn it. */
  const aloudSource = useMemo<AloudSource | null>(() => {
    if (!engine) return null;
    return {
      pageKey: () => (epubRef.current ? epubRef.current.pageKey() : String(unitRef.current)),
      pageText: async () => (epubRef.current ? epubRef.current.visibleText() : engine.getUnitText(unitRef.current).catch(() => '')),
      nextPage: async () => {
        if (epubRef.current) return epubRef.current.nextPage();
        const from = unitRef.current;
        if (!fixedRef.current || from >= engine.unitCount - 1) return false;
        fixedRef.current.goToPage(from + 1);
        for (let i = 0; i < 60 && unitRef.current === from; i++) await new Promise((done) => setTimeout(done, 50));
        return unitRef.current !== from;
      },
    };
  }, [engine]);
  const next = useCallback(() => (fixedRef.current ?? epubRef.current)?.next(), []);
  const prev = useCallback(() => (fixedRef.current ?? epubRef.current)?.prev(), []);
  const closeSideOnNarrow = () => isNarrow() && setSide(null);

  // ---- Touch: taps and the bars of the phone layout ----
  const barsRef = useRef(bars);
  barsRef.current = bars;
  const hideBars = useCallback(() => {
    if (!barsRef.current) return;
    setBars(false);
    if (!isNarrow()) return;
    // The first time the bars leave, say how to get them back.
    try {
      if (localStorage.getItem(HINT_KEY)) return;
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // Without storage the hint simply shows again next time.
    }
    setBarsHint(true);
  }, []);

  useEffect(() => {
    if (!barsHint) return;
    const timer = setTimeout(() => setBarsHint(false), 4500);
    return () => clearTimeout(timer);
  }, [barsHint]);

  const onTap = useCallback(
    (zone: TapZone) => {
      const s = getSettings();
      const pageByPage = fixedRef.current ? s.fixedFlow === 'paged' : s.epubFlow === 'paginated';
      if (pageByPage && s.turnTap && zone !== 'center') {
        if (zone === 'left') prev();
        else next();
        hideBars();
        return;
      }
      if (!isNarrow()) return;
      setBarsHint(false);
      setBars((shown) => !shown);
    },
    [next, prev, hideBars],
  );

  // A book opens with the bars shown, so the controls are seen; a moment later they step aside,
  // unless the reader has reached for them or opened something.
  const barsTouchedRef = useRef(false);
  const busyUiRef = useRef(false);
  busyUiRef.current = Boolean(side || aiOpen || viewMenu || moreMenu || editing || draw || cardDraft || ocrOpen || aiSettings);
  useEffect(() => {
    if (!engine || !isNarrow()) return;
    const timer = setTimeout(() => {
      if (!barsTouchedRef.current && !busyUiRef.current) hideBars();
    }, 3500);
    return () => clearTimeout(timer);
  }, [engine, hideBars]);
  const toggleBars = useCallback(() => {
    barsTouchedRef.current = true;
    setBarsHint(false);
    setBars((shown) => !shown);
  }, []);

  const onEpubPinch = useCallback((dir: 1 | -1) => {
    updateSettings({ epubFontSize: clamp(getSettings().epubFontSize + dir * 10, 70, 220) });
  }, []);

  const goToAnnotation = (a: Annotation) => {
    if (a.cfi) epubRef.current?.goToCfi(a.cfi, a.unit);
    else goToUnit(a.unit);
    closeSideOnNarrow();
  };

  const goToToc = (item: TocItem) => {
    if (engine?.kind === 'epub' && item.href) epubRef.current?.goToHref(item.href, item.unit);
    else if (item.unit !== undefined) goToUnit(item.unit);
    closeSideOnNarrow();
  };

  // ---- Selection, highlights, notes ----
  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    epubRef.current?.clearSelection();
    setSelection(null);
  }, []);

  // On a touch screen the menu for selected text is a bar at the bottom of the screen: the
  // system's own menu (Copy, Look Up…) sits right next to the selection and a second one there
  // would fight it for room.
  const touchUi = mobile || isTouchDevice;
  const selectionTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onViewSelection = useCallback((sel: SelectionInfo | null) => {
    clearTimeout(selectionTimer.current);
    if (sel || !isTouchDevice) return setSelection(sel);
    // A tap on the bar can clear the selection before the tap itself arrives (iPhone does this):
    // the bar stays long enough for that tap to land.
    selectionTimer.current = setTimeout(() => setSelection(null), 450);
  }, []);
  useEffect(() => () => clearTimeout(selectionTimer.current), []);

  const fromSelection = (sel: SelectionInfo, type: 'highlight' | 'note', color: HighlightColor): Annotation[] => {
    const now = Date.now();
    const base = { bookId, color, author: 'user' as const, createdAt: now, updatedAt: now };
    if (sel.cfi) {
      return [{ ...base, id: uid(), type, unit: sel.unit, cfi: sel.cfi, quote: sel.text, label: positionLabel(sel.unit) }];
    }
    return (sel.pages ?? []).map((p, i) => ({
      ...base,
      id: uid(),
      type: i === 0 ? type : 'highlight',
      unit: p.page,
      rects: p.rects,
      quote: i === 0 ? sel.text : undefined,
      label: positionLabel(p.page),
    }));
  };

  const highlightSelection = async (color: HighlightColor) => {
    if (!selection) return;
    await db.annotations.bulkAdd(fromSelection(selection, 'highlight', color));
    clearSelection();
  };

  const noteFromSelection = () => {
    if (!selection) return;
    const [first, ...extra] = fromSelection(selection, 'note', 'yellow');
    if (!first) return;
    setEditing({ annotation: first, isNew: true, extra });
    clearSelection();
  };

  const addPageNote = () => {
    const now = Date.now();
    setEditing({
      isNew: true,
      extra: [],
      annotation: {
        id: uid(),
        bookId,
        type: 'note',
        unit,
        cfi: epubPos?.cfi,
        color: 'yellow',
        label: positionLabel(unit),
        author: 'user',
        createdAt: now,
        updatedAt: now,
      },
    });
  };

  const saveNote = async (a: Annotation) => {
    const extra = editing?.extra.map((x) => ({ ...x, color: a.color })) ?? [];
    await db.annotations.bulkPut([a, ...extra]);
    setEditing(null);
  };

  const deleteAnnotation = async (a: Annotation) => {
    await forgetAnnotation(a);
    setAnnotationPopup(null);
    setEditing(null);
  };

  const askAi = (agentId: string, text: string, quote: string) => {
    setAiOpen(true);
    setAiRequest({ id: uid(), agentId, text, quote });
    setSelection(null);
    setAnnotationPopup(null);
  };

  const attachToAi = (quote: string) => {
    setAiOpen(true);
    setAiQuote(quote);
    setSelection(null);
    setAnnotationPopup(null);
  };

  // ---- Bookmarks ----
  const currentBookmark = useMemo(() => {
    if (!engine) return undefined;
    return annotations.find((a) => {
      if (a.type !== 'bookmark') return false;
      if (engine.kind === 'fixed') return a.unit === unit;
      if (!epubPos || !a.cfi) return false;
      return engine.compareCfi(a.cfi, epubPos.cfi) >= 0 && engine.compareCfi(a.cfi, epubPos.endCfi) <= 0;
    });
  }, [annotations, engine, unit, epubPos]);

  const toggleBookmark = async () => {
    if (!engine) return;
    if (currentBookmark) return void (await forgetAnnotation(currentBookmark));
    if (engine.kind === 'epub' && !epubPos) return;
    const now = Date.now();
    const percent = engine.kind === 'epub' ? ` · ${Math.round(progress * 100)}%` : '';
    let quote: string | undefined;
    if (engine.kind === 'fixed') {
      quote = truncate((await engine.getUnitText(unit).catch(() => '')).replace(/\s+/g, ' ').trim(), 140) || undefined;
    }
    await db.annotations.add({
      id: uid(),
      bookId,
      type: 'bookmark',
      unit,
      cfi: epubPos?.cfi,
      quote,
      color: 'yellow',
      label: `${positionLabel(unit)}${percent}`,
      author: 'user',
      createdAt: now,
      updatedAt: now,
    });
  };

  // ---- Drawing ----
  const onInkChange = useCallback(
    (page: number, strokes: Stroke[], added?: Stroke) => {
      if (added) undoRef.current.push({ page, strokeId: added.id });
      // An erased page is kept as an empty one: sync needs to know that it was erased, and when.
      void db.ink.put({ id: inkId(bookId, page), bookId, page, strokes, updatedAt: Date.now() });
    },
    [bookId],
  );

  const undoStroke = () => {
    const last = undoRef.current.pop();
    if (!last) return;
    onInkChange(last.page, (ink.get(last.page) ?? []).filter((s) => s.id !== last.strokeId));
  };

  const clearPageInk = () => {
    if (!ink.get(unit)?.length) return;
    if (confirm(`Стерти всі малюнки на сторінці ${unit + 1}?`)) onInkChange(unit, []);
  };

  const setTool = (tool: DrawTool) => setDraw((d) => ({ tool, color: d?.color ?? PEN_COLORS[1], size: TOOL_SIZES[tool] }));

  // ---- Search ----
  /** Returns the hits, or `null` when the search was superseded or failed. */
  const runSearch = async (query: string): Promise<SearchHit[] | null> => {
    if (!engine) return null;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setActiveHit(null);
    setSearch({ query, hits: [], busy: true, progress: 0, ranFor: query });
    try {
      const hits = await engine.search(query, {
        signal: controller.signal,
        onProgress: (done, total) => {
          if (!controller.signal.aborted && (done % 8 === 0 || done === total)) setSearch((s) => ({ ...s, progress: done / total }));
        },
      });
      if (controller.signal.aborted) return null;
      setSearch({ query, hits, busy: false, progress: 1, ranFor: query });
      return hits;
    } catch {
      if (!controller.signal.aborted) setSearch((s) => ({ ...s, busy: false }));
      return null;
    }
  };

  const clearSearch = () => {
    searchAbortRef.current?.abort();
    setSearch(NO_SEARCH);
    setActiveHit(null);
  };

  // ---- Opened from a search across the library: go straight to what was found ----
  useEffect(() => {
    if (!engine) return;
    const jump = takeJump(bookId);
    if (!jump) return;
    let alive = true;
    if (jump.ask) askAi(jump.ask.agentId, jump.ask.text, '');
    if (jump.thread) {
      setAiOpen(true);
      setAiThread(jump.thread);
    }
    const target = jump.unit;
    if (target === undefined) return;
    // The page or chapter at once; the exact spot as soon as it has been located.
    goToUnit(target);
    void (async () => {
      if (jump.passage) {
        const cfi = engine.kind === 'epub' ? await engine.locatePassage(target, jump.passage).catch(() => null) : null;
        if (alive && cfi) epubRef.current?.goToCfi(cfi, target);
        return;
      }
      if (!jump.query) return;
      if (!isNarrow()) setSide('search');
      const hits = await runSearch(jump.query);
      if (!alive || !hits) return;
      const inUnit = hits.filter((h) => h.unit === target);
      // PDF/DjVu hits carry their number on the page; in an EPUB chapter they are simply in reading order.
      const hit = inUnit.find((h) => h.matchIndex !== undefined && h.matchIndex === jump.matchIndex) ?? inUnit[jump.matchIndex ?? 0] ?? inUnit[0];
      if (hit) setActiveHit(hit);
    })();
    return () => {
      alive = false;
    };
    // Runs once, when the book has opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // ---- Statistics: counted while the book is open ----
  useEffect(() => {
    if (!engine) return;
    const tracker = startTracking(bookId);
    trackerRef.current = tracker;
    const activity = () => tracker.activity();
    window.addEventListener('pointerdown', activity, true);
    window.addEventListener('keydown', activity, true);
    window.addEventListener('wheel', activity, { capture: true, passive: true });
    window.addEventListener('touchmove', activity, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', activity, true);
      window.removeEventListener('keydown', activity, true);
      window.removeEventListener('wheel', activity, { capture: true });
      window.removeEventListener('touchmove', activity, { capture: true });
      tracker.stop();
      if (trackerRef.current === tracker) trackerRef.current = null;
    };
  }, [engine, bookId]);

  // ---- Contents made from the text ----
  const madeTocRef = useRef(madeToc);
  madeTocRef.current = madeToc;
  /** Reads the book's text and makes a table of contents from it; in the background unless asked for. */
  const makeToc = useCallback(
    async (force = false) => {
      const layered = ocrEngine;
      if (!layered || madeTocAbortRef.current) return;
      const controller = new AbortController();
      madeTocAbortRef.current = controller;
      setMadeToc({ status: 'building', progress: { done: 0, total: layered.unitCount } });
      try {
        const { buildAutoToc, saveAutoToc } = await import('../lib/auto-toc');
        const ocrPages = layered.ocrCount;
        const made = await buildAutoToc(layered, (progress) => setMadeToc({ status: 'building', progress }), controller.signal);
        if (controller.signal.aborted) return;
        await saveAutoToc(bookId, made, ocrPages);
        layered.setMadeToc(made.items);
        setToc(await layered.getToc());
        // A book without text at all gives nothing, and says why.
        const anyText = made.items.length || (await layered.getUnitText(0).catch(() => '')).trim() || (await layered.getUnitText(Math.min(layered.unitCount - 1, 5)).catch(() => '')).trim();
        setMadeToc({ status: made.items.length ? 'ready' : anyText ? 'empty' : 'no-text', source: made.source });
        if (force && made.items.length) setReaderNotice(made.source === 'contents' ? 'Зміст узято зі сторінки змісту книги.' : `Зміст складено за заголовками: ${made.items.length} розділ(и) верхнього рівня.`);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) setMadeToc({ status: 'idle' });
      } finally {
        if (madeTocAbortRef.current === controller) madeTocAbortRef.current = null;
      }
    },
    [ocrEngine, bookId],
  );

  // A book without contents of its own gets them made once, in the background, a moment after it opens.
  useEffect(() => {
    if (!engine || !ocrEngine || madeToc?.status !== 'idle') return;
    const timer = setTimeout(() => void makeToc(), 1500);
    return () => clearTimeout(timer);
  }, [engine, ocrEngine, madeToc?.status, makeToc]);

  // ---- OCR ----
  const startOcr = async (scope: 'page' | 'book') => {
    if (!ocrEngine || ocrAbortRef.current) return;
    const controller = new AbortController();
    ocrAbortRef.current = controller;
    const pages = scope === 'page' ? [unitRef.current] : Array.from({ length: ocrEngine.unitCount }, (_, i) => i);
    setOcrJob({ progress: null, running: true, error: null });
    try {
      await runOcr({
        engine: ocrEngine,
        bookId,
        pages,
        langs: getSettings().ocrLangs,
        force: scope === 'page',
        signal: controller.signal,
        onProgress: (p) => setOcrJob((job) => ({ ...job, progress: { ...p } })),
      });
      setOcrJob((job) => ({ ...job, running: false }));
      // More text: contents made from it may now be found, or found better.
      if (scope === 'book' && madeTocRef.current) void makeToc(true);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setOcrJob((job) => ({ ...job, running: false, error: controller.signal.aborted ? null : `Не вдалося розпізнати текст: ${reason}` }));
    } finally {
      ocrAbortRef.current = null;
    }
  };

  const clearOcrResults = async () => {
    if (!ocrEngine || !confirm('Видалити розпізнаний текст усіх сторінок цієї книги?')) return;
    await clearOcr(ocrEngine, bookId);
    setOcrJob({ progress: null, ...IDLE_JOB });
  };

  // ---- Semantic search ----
  const positionLabelRef = useRef(positionLabel);
  positionLabelRef.current = positionLabel;

  /** Shared by the search panel and the agents' tool; `null` means there is no usable index. */
  const semanticSearch = useCallback(async (query: string, limit: number): Promise<SemanticHit[] | null> => {
    const index = vectorIndexRef.current;
    const embedder = getEmbedder(getSettings());
    if (!index || 'missing' in embedder || embedder.id !== index.model) return null;
    const hits = await searchIndex(index, embedder, query, limit);
    return hits.map((h) => ({ ...h, label: positionLabelRef.current(h.unit) }));
  }, []);

  const buildSemanticIndex = async () => {
    const embedder = getEmbedder(getSettings());
    if (!engine || semanticAbortRef.current || 'missing' in embedder) return;
    const controller = new AbortController();
    semanticAbortRef.current = controller;
    setSemanticQuery(NO_SEMANTIC_QUERY);
    setSemanticBuild({ progress: null, running: true, error: null });
    try {
      const index = await buildIndex({
        engine,
        bookId,
        embedder,
        signal: controller.signal,
        onProgress: (p) => setSemanticBuild((b) => ({ ...b, progress: p })),
      });
      if (index) setVectorIndex(index);
      setSemanticBuild({ progress: null, ...IDLE_JOB });
    } catch (err) {
      setSemanticBuild({ progress: null, running: false, error: controller.signal.aborted ? null : describeEmbedError(err, getSettings()) });
    } finally {
      semanticAbortRef.current = null;
    }
  };

  const runSemanticSearch = async (query: string) => {
    setSemanticQuery({ ranFor: query, busy: true, hits: [], error: null });
    try {
      const hits = await semanticSearch(query, 12);
      setSemanticQuery({ ranFor: query, busy: false, hits: hits ?? [], error: hits ? null : 'Індекс недоступний — побудуйте його заново.' });
    } catch (err) {
      setSemanticQuery({ ranFor: query, busy: false, hits: [], error: describeEmbedError(err, getSettings()) });
    }
  };

  const goToSemanticHit = async (hit: SemanticHit) => {
    const cfi = engine?.kind === 'epub' ? await engine.locatePassage(hit.unit, hit.text) : null;
    if (cfi) epubRef.current?.goToCfi(cfi, hit.unit);
    else goToUnit(hit.unit);
    closeSideOnNarrow();
  };

  const deleteSemanticIndex = async () => {
    await db.vectors.delete(bookId);
    setVectorIndex(null);
    setSemanticQuery(NO_SEMANTIC_QUERY);
  };

  // ---- AI ----
  const bookInfo = useMemo(
    () => book,
    // The record changes on every saved position; agents only need its stable fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [book?.id, book?.title, book?.author, book?.unitCount],
  );

  const agentCtx = useMemo<AgentContext | null>(() => {
    if (!engine || !bookInfo) return null;
    return {
      book: bookInfo,
      engine,
      getCurrentUnit: () => unitRef.current,
      getChapterTitle: (u = unitRef.current) => chapterTitle(u),
      goToUnit,
      semanticSearch,
      study: studyApiFor(bookInfo),
      unitLabel: positionLabel,
      listAnnotations: async () => sortAnnotations(await db.annotations.where('bookId').equals(bookId).toArray()),
      createNote: async ({ unit: u, text, quote }) => {
        const now = Date.now();
        await db.annotations.add({
          id: uid(),
          bookId,
          type: 'note',
          unit: u,
          text,
          quote,
          color: 'blue',
          label: positionLabel(u),
          author: 'agent',
          createdAt: now,
          updatedAt: now,
        });
      },
    };
  }, [engine, bookInfo, bookId, chapterTitle, positionLabel, goToUnit, semanticSearch]);

  /** "Let the AI write this field" for the note and card editors. */
  const fillWithAi = useMemo(() => (agentCtx ? (task: string, quote?: string) => quickFill(agentCtx, task, quote) : undefined), [agentCtx]);
  const onAiRequestHandled = useCallback(() => setAiRequest(null), []);
  const onAiQuoteClear = useCallback(() => setAiQuote(null), []);

  // ---- Keyboard & fullscreen ----
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSide('search');
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const epub = Boolean(epubRef.current);
      switch (e.key) {
        case 'ArrowRight':
          next();
          break;
        case 'ArrowLeft':
          prev();
          break;
        case 'PageDown':
        case ' ': {
          const dir = e.shiftKey ? -1 : 1;
          // A continuous PDF/DjVu scroll is left to the browser; everything else turns pages itself.
          if (!epub) {
            if (!fixedRef.current?.step(dir)) return;
          } else if (dir < 0) prev();
          else next();
          break;
        }
        case 'PageUp':
          if (!epub) {
            if (!fixedRef.current?.step(-1)) return;
          } else prev();
          break;
        case 'Escape':
          setSelection(null);
          setAnnotationPopup(null);
          setViewMenu(false);
          setDraw(null);
          return;
        default:
          return;
      }
      e.preventDefault();
    },
    [next, prev],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  };

  const onViewportMove = useCallback(() => setAnnotationPopup(null), []);
  const onZoom = useCallback((factor: number) => {
    const current = fixedRef.current?.getScale() ?? 1;
    updateSettings({ fixedZoom: clamp(Math.round(current * factor * 100) / 100, 0.25, 6) });
  }, []);
  const onAnnotationClick = useCallback((a: Annotation, anchor: SelectionInfo['anchor']) => {
    setSelection(null);
    setAnnotationPopup({ id: a.id, anchor });
  }, []);

  // ---- Render ----
  if (error) {
    return (
      <div className="reader-state">
        <p>Не вдалося відкрити книгу.</p>
        <p className="muted">{error}</p>
        <button className="btn primary" onClick={onExit}>
          До бібліотеки
        </button>
      </div>
    );
  }
  if (!engine || !book) {
    return (
      <div className="reader-state">
        <LoaderCircle size={28} className="spin" />
        <p className="muted">
          {downloading
            ? 'Завантажую книгу зі сховища…'
            : reflowProgress
              ? `Готую текстовий режим: стор. ${reflowProgress.done} з ${reflowProgress.total}`
              : 'Відкриваю книгу…'}
        </p>
        {reflowProgress && <p className="muted small">Це робиться один раз для книги.</p>}
      </div>
    );
  }

  const isFixed = engine.kind === 'fixed';
  /** Pages are what the reader moves through: a PDF/DjVu book, in either mode. */
  const byPage = isFixed || reflow;
  // ---- Time left, from the reader's own pace ----
  const pace = paceOf(readingLog ?? [], bookId);
  const nextChapter = flatToc.find((entry) => entry.unit > unit)?.unit;
  const pagesLeftInChapter = !byPage
    ? epubPos && settings.epubFlow === 'paginated'
      ? Math.max(0, epubPos.chapterPages - epubPos.chapterPage)
      : null
    : (nextChapter ?? unitCount) - unit - (nextChapter === undefined ? 1 : 0);
  const progressNow = byPage
    ? unitCount > 1
      ? unit / (unitCount - 1)
      : 1
    : ((locationsReady && epubPos ? engine.percentageFromCfi(epubPos.cfi) : null) ?? epubPos?.percent ?? book.progress);
  const progress = progressNow;
  const chapterSeconds = pace.secondsPerPage && pagesLeftInChapter !== null ? pagesLeftInChapter * pace.secondsPerPage : null;
  const bookSeconds = pace.progressPerSecond ? (1 - progress) / pace.progressPerSecond : byPage && pace.secondsPerPage ? (unitCount - 1 - unit) * pace.secondsPerPage : null;
  const chapterLeft =
    chapterSeconds !== null ? `≈${durationLabel(chapterSeconds)} до кінця розділу` : pagesLeftInChapter ? `ще ${pagesLeftInChapter} стор. у розділі` : null;
  const bookLeft = bookSeconds && bookSeconds > 60 ? `≈${durationLabel(bookSeconds)} до кінця книги` : null;
  const popupAnnotation = annotationPopup ? annotations.find((a) => a.id === annotationPopup.id) : undefined;
  const toggleSide = (tab: SideTab) => setSide((s) => (s === tab ? null : tab));

  const embedder = getEmbedder(settings);
  const semantic: SemanticState = {
    status: semanticBuild.running ? 'building' : !vectorIndex ? 'none' : 'id' in embedder && embedder.id === vectorIndex.model ? 'ready' : 'stale',
    backendLabel: 'label' in embedder ? embedder.label : '',
    backendMissing: 'missing' in embedder ? embedder.missing : null,
    progress: semanticBuild.progress,
    passages: vectorIndex?.chunks.length ?? 0,
    ...semanticQuery,
    error: semanticBuild.error ?? semanticQuery.error,
  };

  /** The study topic of this book (made on first use). */
  const openStudy = () => {
    void topicForBook(book).then((topic) => {
      location.hash = `#/study/topic/${topic.id}`;
    });
  };
  const toggleDraw = () => {
    clearSelection();
    setDraw((d) => (d ? null : { tool: 'pen', color: PEN_COLORS[1], size: TOOL_SIZES.pen }));
  };
  const bookmarkButton = (
    <ToolButton
      icon={currentBookmark ? BookmarkCheck : Bookmark}
      label={currentBookmark ? 'Прибрати закладку' : 'Додати закладку'}
      active={Boolean(currentBookmark)}
      onClick={() => void toggleBookmark()}
    />
  );
  const viewButton = <ToolButton icon={Type} label="Вигляд: тема, шрифт, масштаб" active={viewMenu} onClick={() => setViewMenu((v) => !v)} />;
  // While drawing, the bars of the phone layout stay put beside the page, so every part of it can be reached.
  const overlay = mobile && !draw;
  // The app's own places for swiping; while drawing, touches belong to the pen.
  const swipeZone = settings.turnZone && !draw;
  const viewApi = () => fixedRef.current ?? epubRef.current;

  return (
    <div className={cx('reader', settings.invertInDark && 'invert-pages', mobile && 'mobile', overlay && 'overlay-bars', overlay && !bars && 'bars-hidden', swipeZone && 'with-swipe-bar', engine.kind === 'epub' && `margins-${settings.epubMargins}`)}>
      {!(mobile && draw) && (
        <header className="reader-bar" onPointerDownCapture={() => (barsTouchedRef.current = true)}>
          <button className="icon-btn" onClick={onExit} title="До бібліотеки">
            <ArrowLeft size={20} />
          </button>
          <div className="reader-title">
            <strong>{book.title}</strong>
            {book.author && <small>{book.author}</small>}
          </div>
          {mobile ? (
            <div className="reader-tools">
              {viewButton}
              {bookmarkButton}
            </div>
          ) : (
            <div className="reader-tools">
              <ToolButton icon={List} label="Зміст" active={side === 'toc'} onClick={() => toggleSide('toc')} />
              <ToolButton icon={Search} label="Пошук (Ctrl+F)" active={side === 'search'} onClick={() => toggleSide('search')} />
              <ToolButton icon={StickyNote} label="Нотатки та виділення" active={side === 'notes'} onClick={() => toggleSide('notes')} />
              {bookmarkButton}
              <ToolButton icon={MessageSquarePlus} label="Нотатка до цього місця" onClick={addPageNote} />
              <ToolButton icon={Brain} label="Навчання: картки й повторення за цією книгою" onClick={openStudy} />
              <ToolButton icon={Users} label="X-Ray: імена й назви в книзі" active={Boolean(xray)} onClick={() => setXray(xray ? null : { term: null })} />
              <ToolButton icon={Volume2} label="Читати вголос" active={aloudBar} onClick={() => setAloudBar((on) => !on)} />
              {isFixed && <ToolButton icon={Pencil} label="Малювати на сторінці" active={Boolean(draw)} onClick={toggleDraw} />}
              {ocrEngine && <ToolButton icon={ScanText} label="Розпізнати текст скану (OCR)" active={ocrJob.running} onClick={() => setOcrOpen(true)} />}
              {viewButton}
              {/* iPhones have no fullscreen mode for web pages; an installed app is full-screen already. */}
              {document.fullscreenEnabled && (
                <ToolButton icon={fullscreen ? Minimize : Maximize} label={fullscreen ? 'Вийти з повного екрана' : 'На весь екран'} onClick={toggleFullscreen} />
              )}
              <button className={cx('btn ai-toggle', aiOpen && 'active')} onClick={() => setAiOpen((o) => !o)} title="AI-агенти">
                <Sparkles size={16} />
                <span>AI</span>
              </button>
            </div>
          )}
        </header>
      )}

      {draw && (
        <div className="draw-bar">
          <ToolButton icon={Pencil} label="Олівець" active={draw.tool === 'pen'} onClick={() => setTool('pen')} />
          <ToolButton icon={Highlighter} label="Маркер" active={draw.tool === 'marker'} onClick={() => setTool('marker')} />
          <ToolButton icon={Eraser} label="Гумка (стирає штрих цілком)" active={draw.tool === 'eraser'} onClick={() => setTool('eraser')} />
          <span className="tool-sep" />
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              className={cx('swatch', draw.color === c && draw.tool !== 'eraser' && 'selected')}
              style={{ background: c }}
              aria-label={`Колір ${c}`}
              onClick={() => setDraw((d) => ({ tool: d?.tool === 'marker' ? 'marker' : 'pen', color: c, size: TOOL_SIZES[d?.tool === 'marker' ? 'marker' : 'pen'] }))}
            />
          ))}
          <span className="tool-sep" />
          <ToolButton icon={Undo2} label="Скасувати останній штрих" onClick={undoStroke} />
          <ToolButton icon={Trash2} label="Стерти все на цій сторінці" onClick={clearPageInk} />
          <span className="spacer" />
          <button className="btn small" onClick={() => setDraw(null)}>
            Готово
          </button>
        </div>
      )}

      <div className="reader-body">
        {xray && !side && (
          <Suspense fallback={null}>
            <XrayPanel
              bookId={bookId}
              engine={engine}
              unit={unit}
              unitLabel={positionLabel}
              initialTerm={xray.term}
              onGo={(u) => {
                goToUnit(u);
                closeSideOnNarrow();
                if (isNarrow()) setXray(null);
              }}
              describe={agentCtx && settings.aiProvider ? (task, passages) => quickFill(agentCtx, task, passages) : undefined}
              onClose={() => setXray(null)}
            />
          </Suspense>
        )}
        {side && (
          <SidePanel
            tab={side}
            onTab={setSide}
            onClose={() => setSide(null)}
            toc={toc}
            madeToc={madeToc && !reflow ? { ...madeToc, onBuild: () => void makeToc(true) } : undefined}
            currentUnit={unit}
            onTocPick={goToToc}
            search={search}
            activeHit={activeHit}
            onSearch={(q) => void runSearch(q)}
            onSearchClear={clearSearch}
            onHitPick={(hit) => {
              setActiveHit(hit);
              closeSideOnNarrow();
            }}
            semantic={semantic}
            onSemanticBuild={() => void buildSemanticIndex()}
            onSemanticCancel={() => semanticAbortRef.current?.abort()}
            onSemanticSearch={(q) => void runSemanticSearch(q)}
            onSemanticPick={(hit) => void goToSemanticHit(hit)}
            onSemanticDelete={() => void deleteSemanticIndex()}
            canOcr={Boolean(ocrEngine)}
            onOpenOcr={() => setOcrOpen(true)}
            onOpenAiSettings={() => setAiSettings(true)}
            annotations={annotations}
            onAnnotationPick={goToAnnotation}
            onAnnotationEdit={(a) => setEditing({ annotation: a, isNew: false, extra: [] })}
            onAnnotationDelete={(a) => void deleteAnnotation(a)}
            onExportNotes={() => exportNotesMarkdown(book, annotations)}
          />
        )}

        <main className="reader-content">
          {engine.kind === 'fixed' ? (
            <PagedView
              ref={fixedRef}
              engine={engine}
              // Read when the view mounts: at opening, and again when the layout is switched mid-book.
              initialPage={clamp(unit, 0, unitCount - 1)}
              flow={settings.fixedFlow}
              swipe={settings.turnSwipe}
              swipe2={settings.turnSwipe2}
              spread={spreadWanted}
              zoom={settings.fixedZoom}
              annotations={annotations}
              ink={ink}
              draw={draw}
              searchQuery={search.ranFor}
              activeHit={activeHit}
              onPageChange={onPageChange}
              onSelection={onViewSelection}
              onAnnotationClick={onAnnotationClick}
              onInkChange={onInkChange}
              onViewportMove={onViewportMove}
              onScale={setScale}
              onZoom={onZoom}
              onTap={onTap}
              onReadingGesture={hideBars}
            />
          ) : (
            <EpubView
              ref={epubRef}
              engine={engine}
              initialCfi={startPosition}
              theme={settings.theme}
              fontSize={settings.epubFontSize}
              font={settings.epubFont}
              lineHeight={settings.epubLineHeight}
              flow={settings.epubFlow}
              swipe={settings.turnSwipe}
              swipe2={settings.turnSwipe2}
              typography={typography}
              customFontUrl={customFontUrl}
              spread={spreadWanted}
              onFootnote={setFootnote}
              annotations={annotations}
              activeHit={activeHit}
              onRelocated={onRelocated}
              onSelection={onViewSelection}
              onAnnotationClick={onAnnotationClick}
              onKey={onKey}
              onTap={onTap}
              onReadingGesture={hideBars}
              onPinch={onEpubPinch}
            />
          )}
        </main>

        {aiOpen && agentCtx && (
          <Suspense
            fallback={
              <aside className="ai-panel ai-loading">
                <LoaderCircle size={22} className="spin" />
              </aside>
            }
          >
            <AiPanel
              ctx={agentCtx}
              request={aiRequest}
              onRequestHandled={onAiRequestHandled}
              quote={aiQuote}
              onQuoteClear={onAiQuoteClear}
              openThread={aiThread}
              onOpenSettings={() => setAiSettings(true)}
              onClose={() => setAiOpen(false)}
            />
          </Suspense>
        )}
      </div>

      <footer className="reader-foot" onPointerDownCapture={() => (barsTouchedRef.current = true)}>
        <div className="foot-seek">
        <button className="icon-btn foot-step" onClick={prev} title="Назад (←)">
          <ChevronLeft size={20} />
        </button>
        {byPage ? (
          <>
            <form
              className="page-form"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(pageDraft);
                if (Number.isFinite(n) && n >= 1) goToUnit(Math.min(unitCount, Math.round(n)) - 1);
                setPageDraft(null);
                (document.activeElement as HTMLElement | null)?.blur();
              }}
            >
              <input
                className="page-input"
                inputMode="numeric"
                aria-label="Номер сторінки"
                value={pageDraft ?? String(unit + 1)}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setPageDraft(e.target.value.replace(/[^\d]/g, ''))}
                onBlur={() => setPageDraft(null)}
              />
              <span className="muted">/ {unitCount}</span>
            </form>
            {(chapterLeft || bookLeft) && <span className="muted time-left">{[chapterLeft, bookLeft].filter(Boolean).join(' · ')}</span>}
            <input
              className="seek"
              type="range"
              aria-label="Позиція в книзі"
              min={0}
              max={Math.max(0, unitCount - 1)}
              value={unit}
              onChange={(e) => goToUnit(Number(e.target.value))}
            />
          </>
        ) : (
          <>
            <span className="chapter-label" title={chapterTitle(unit)}>
              {chapterTitle(unit) ?? `Розділ ${unit + 1}`}
              {epubPos && epubPos.chapterPages > 1 && settings.epubFlow === 'paginated' && (
                <span className="muted">
                  {' '}
                  · {epubPos.chapterPage}/{epubPos.chapterPages}
                </span>
              )}
              {(chapterLeft || bookLeft) && <span className="muted time-left"> · {[chapterLeft, bookLeft].filter(Boolean).join(' · ')}</span>}
            </span>
            <input
              className="seek"
              type="range"
              aria-label="Позиція в книзі"
              min={0}
              max={1000}
              value={seekDraft ?? Math.round(progress * 1000)}
              onChange={(e) => setSeekDraft(Number(e.target.value))}
              onPointerUp={() => commitSeek()}
              onKeyUp={() => commitSeek()}
              onBlur={() => commitSeek()}
            />
          </>
        )}
        <span className="percent">{Math.round((seekDraft !== null ? seekDraft / 1000 : progress) * 100)}%</span>
        <button className="icon-btn foot-step" onClick={next} title="Далі (→)">
          <ChevronRight size={20} />
        </button>
        </div>
        {overlay && (
          <nav className="tabbar" aria-label="Розділи читалки">
            <TabButton icon={List} label="Зміст" active={side === 'toc'} onClick={() => toggleSide('toc')} />
            <TabButton icon={Search} label="Пошук" active={side === 'search'} onClick={() => toggleSide('search')} />
            <TabButton icon={Sparkles} label="AI" accent active={aiOpen} onClick={() => setAiOpen((o) => !o)} />
            <TabButton icon={StickyNote} label="Нотатки" active={side === 'notes'} onClick={() => toggleSide('notes')} />
            <TabButton icon={Ellipsis} label="Ще" active={moreMenu} onClick={() => setMoreMenu(true)} />
          </nav>
        )}
      </footer>

      {swipeZone && (
        <SwipeZones
          onDrag={(dx) => viewApi()?.drag(dx)}
          onRelease={(dx, ms) => {
            viewApi()?.release(dx, ms);
            if (Math.abs(dx) > 30) hideBars();
          }}
          onTap={onTap}
          label={byPage ? `стор. ${unit + 1} / ${unitCount}` : `${truncate(chapterTitle(unit) ?? `Розділ ${unit + 1}`, 28)} · ${Math.round(progress * 100)}%`}
          hint={chapterLeft ?? bookLeft ?? undefined}
          progress={progress}
        />
      )}
      {settings.turnButtons && (
        <TurnButtons
          onPrev={prev}
          onNext={next}
          onMenu={overlay ? toggleBars : undefined}
          onBookmark={() => void toggleBookmark()}
          bookmarked={Boolean(currentBookmark)}
          onToc={() => toggleSide('toc')}
          onAi={() => setAiOpen((o) => !o)}
        />
      )}
      {settings.gestureDebug && <GestureDebug />}
      {aloudBar && aloudSource && <ReadAloudBar source={aloudSource} onClose={() => setAloudBar(false)} />}

      {/* With the bars away, a hairline at the bottom edge still shows how far into the book this is. */}
      {overlay && (
        <div className="reader-progress" aria-hidden>
          <div style={{ width: `${Math.round(progress * 1000) / 10}%` }} />
        </div>
      )}
      {overlay && barsHint && (
        <div className="reader-hint" role="status">
          {swipeZone ? 'Гортайте свайпом по смузі внизу. Дотик до середини екрана показує меню' : 'Торкніться середини екрана, щоб показати меню'}
        </div>
      )}
      {moreMenu && (
        <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setMoreMenu(false)}>
          <div className="modal action-sheet" role="menu" aria-label="Ще">
            <SheetItem
              icon={MessageSquarePlus}
              label="Нотатка до цього місця"
              onClick={() => {
                setMoreMenu(false);
                addPageNote();
              }}
            />
            <SheetItem
              icon={Brain}
              label="Навчання за цією книгою"
              onClick={() => {
                setMoreMenu(false);
                openStudy();
              }}
            />
            <SheetItem
              icon={Users}
              label="X-Ray: імена й назви"
              onClick={() => {
                setMoreMenu(false);
                setSide(null);
                setXray({ term: null });
              }}
            />
            <SheetItem
              icon={Volume2}
              label="Читати вголос"
              onClick={() => {
                setMoreMenu(false);
                setAloudBar(true);
              }}
            />
            <SheetItem
              icon={Bookmark}
              label="Закладки"
              onClick={() => {
                setMoreMenu(false);
                setSide('bookmarks');
              }}
            />
            {isFixed && (
              <SheetItem
                icon={Pencil}
                label="Малювати на сторінці"
                onClick={() => {
                  setMoreMenu(false);
                  toggleDraw();
                }}
              />
            )}
            {ocrEngine && (
              <SheetItem
                icon={ScanText}
                label="Розпізнати текст скану (OCR)"
                onClick={() => {
                  setMoreMenu(false);
                  setOcrOpen(true);
                }}
              />
            )}
            {document.fullscreenEnabled && (
              <SheetItem
                icon={fullscreen ? Minimize : Maximize}
                label={fullscreen ? 'Вийти з повного екрана' : 'На весь екран'}
                onClick={() => {
                  setMoreMenu(false);
                  toggleFullscreen();
                }}
              />
            )}
            <button className="btn sheet-cancel" onClick={() => setMoreMenu(false)}>
              Скасувати
            </button>
          </div>
        </div>
      )}

      {quoteCard && book && (
        <Suspense fallback={null}>
          <QuoteCard text={quoteCard} title={book.title} author={book.author} onClose={() => setQuoteCard(null)} />
        </Suspense>
      )}
      {footnote && (
        <div className="modal-backdrop footnote-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setFootnote(null)}>
          <div className="footnote-sheet" role="dialog" aria-label="Примітка">
            <p>{footnote.text}</p>
            <div className="footnote-actions">
              <button
                className="btn small"
                onClick={() => {
                  epubRef.current?.goToHref(footnote.href);
                  setFootnote(null);
                }}
              >
                Перейти до примітки
              </button>
              <button className="btn small primary" onClick={() => setFootnote(null)}>
                Закрити
              </button>
            </div>
          </div>
        </div>
      )}
      {readerNotice && !remotePosition && (
        <div className="reader-toast" role="status">
          <span>{readerNotice}</span>
          <button className="icon-btn" onClick={() => setReaderNotice(null)} title="Закрити" aria-label="Закрити">
            <X size={16} />
          </button>
        </div>
      )}
      {remotePosition && (
        <div className="reader-toast" role="status">
          <span>
            На іншому пристрої ви зупинилися {remotePosition.progress > progress ? 'далі' : 'раніше'}:{' '}
            {byPage ? `стор. ${(Number(remotePosition.position) || 0) + 1}` : `${Math.round(remotePosition.progress * 100)}%`}
          </span>
          <button className="btn small primary" onClick={() => dismissRemotePosition(true)}>
            Перейти
          </button>
          <button className="icon-btn" onClick={() => dismissRemotePosition(false)} title="Залишитися тут">
            <X size={16} />
          </button>
        </div>
      )}

      {selection && !draw && !editing && touchUi && (
        <div className="action-bar" role="toolbar" aria-label="Дії з виділеним текстом" onMouseDown={(e) => e.preventDefault()}>
          {isWord(selection.text) && (
            <DictionaryCard
              word={selection.text.trim()}
              onAskAi={() => askAi('explainer', `Що означає слово «${selection.text.trim()}» у цьому місці книги? Коротко.`, selection.text)}
              xrayCount={xrayNames?.get(selection.text.trim().toLocaleLowerCase())}
              onXray={() => {
                setXray({ term: selection.text.trim() });
                clearSelection();
              }}
            />
          )}
          <div className="action-bar-top">
            <ColorDots onPick={(c) => void highlightSelection(c)} />
            <span className="action-quote">«{truncate(selection.text.replace(/\s+/g, ' '), 70)}»</span>
            <button className="icon-btn" onClick={clearSelection} title="Зняти виділення" aria-label="Зняти виділення">
              <X size={18} />
            </button>
          </div>
          <div className="action-bar-row">
            <TabButton icon={StickyNote} label="Нотатка" onClick={noteFromSelection} />
            <TabButton
              icon={Layers}
              label="Картка"
              onClick={() => {
                setCardDraft({ back: selection.text, quote: selection.text, unit: selection.unit, label: positionLabel(selection.unit) });
                clearSelection();
              }}
            />
            <TabButton
              icon={Copy}
              label="Копіювати"
              onClick={() => {
                void navigator.clipboard?.writeText(selection.text);
                clearSelection();
              }}
            />
            <TabButton icon={BookOpenCheck} label="Пояснити" onClick={() => askAi('explainer', 'Поясни цей фрагмент.', selection.text)} />
            <TabButton icon={Languages} label="Переклад" onClick={() => askAi('translator', 'Переклади цей фрагмент.', selection.text)} />
            <TabButton icon={MessageSquare} label="Запитати" onClick={() => attachToAi(selection.text)} />
            <TabButton
              icon={ImageIcon}
              label="Картинка"
              onClick={() => {
                setQuoteCard(selection.text);
                clearSelection();
              }}
            />
          </div>
        </div>
      )}

      {selection && !draw && !editing && !touchUi && (
        <Popup anchor={selection.anchor}>
          <ColorDots onPick={(c) => void highlightSelection(c)} />
          <span className="tool-sep" />
          <PopupButton icon={StickyNote} label="Нотатка" onClick={noteFromSelection} />
          <PopupButton
            icon={Layers}
            label="Картка для запам’ятовування"
            onClick={() => {
              setCardDraft({ back: selection.text, quote: selection.text, unit: selection.unit, label: positionLabel(selection.unit) });
              clearSelection();
            }}
          />
          <PopupButton icon={Copy} label="Копіювати" onClick={() => void navigator.clipboard?.writeText(selection.text)} />
          <span className="tool-sep" />
          <PopupButton icon={BookOpenCheck} label="Пояснити" onClick={() => askAi('explainer', 'Поясни цей фрагмент.', selection.text)} />
          <PopupButton icon={Languages} label="Перекласти" onClick={() => askAi('translator', 'Переклади цей фрагмент.', selection.text)} />
          <PopupButton icon={MessageSquare} label="Запитати AI" onClick={() => attachToAi(selection.text)} />
          <PopupButton
            icon={ImageIcon}
            label="Цитата як картинка"
            onClick={() => {
              setQuoteCard(selection.text);
              clearSelection();
            }}
          />
          {isWord(selection.text) && (
            <div className="popup-dictionary">
              <DictionaryCard
                word={selection.text.trim()}
                onAskAi={() => askAi('explainer', `Що означає слово «${selection.text.trim()}» у цьому місці книги? Коротко.`, selection.text)}
                xrayCount={xrayNames?.get(selection.text.trim().toLocaleLowerCase())}
                onXray={() => {
                  setXray({ term: selection.text.trim() });
                  clearSelection();
                }}
              />
            </div>
          )}
        </Popup>
      )}

      {annotationPopup && popupAnnotation && !editing && touchUi && (
        <div className="action-bar" role="toolbar" aria-label="Дії з виділенням">
          <div className="action-bar-top">
            <ColorDots value={popupAnnotation.color} onPick={(color) => void db.annotations.update(popupAnnotation.id, { color, updatedAt: Date.now() })} />
            <span className="action-quote">{popupAnnotation.quote ? `«${truncate(popupAnnotation.quote.replace(/\s+/g, ' '), 70)}»` : popupAnnotation.label}</span>
            <button className="icon-btn" onClick={() => setAnnotationPopup(null)} title="Закрити" aria-label="Закрити">
              <X size={18} />
            </button>
          </div>
          <div className="action-bar-row">
            <TabButton
              icon={StickyNote}
              label={popupAnnotation.text ? 'Нотатка' : 'Додати нотатку'}
              onClick={() => {
                setEditing({ annotation: popupAnnotation, isNew: false, extra: [] });
                setAnnotationPopup(null);
              }}
            />
            {popupAnnotation.quote && <TabButton icon={BookOpenCheck} label="Пояснити" onClick={() => askAi('explainer', 'Поясни цей фрагмент.', popupAnnotation.quote!)} />}
            {popupAnnotation.quote && <TabButton icon={MessageSquare} label="Запитати" onClick={() => attachToAi(popupAnnotation.quote!)} />}
            <TabButton icon={Trash2} label="Видалити" onClick={() => void deleteAnnotation(popupAnnotation)} />
          </div>
        </div>
      )}

      {annotationPopup && popupAnnotation && !editing && !touchUi && (
        <Popup anchor={annotationPopup.anchor}>
          <ColorDots value={popupAnnotation.color} onPick={(color) => void db.annotations.update(popupAnnotation.id, { color, updatedAt: Date.now() })} />
          <span className="tool-sep" />
          <PopupButton
            icon={StickyNote}
            label={popupAnnotation.text ? 'Відкрити нотатку' : 'Додати нотатку'}
            onClick={() => {
              setEditing({ annotation: popupAnnotation, isNew: false, extra: [] });
              setAnnotationPopup(null);
            }}
          />
          {popupAnnotation.quote && (
            <PopupButton icon={BookOpenCheck} label="Пояснити" onClick={() => askAi('explainer', 'Поясни цей фрагмент.', popupAnnotation.quote!)} />
          )}
          <PopupButton icon={Trash2} label="Видалити" onClick={() => void deleteAnnotation(popupAnnotation)} />
          <PopupButton icon={X} label="Закрити" onClick={() => setAnnotationPopup(null)} />
        </Popup>
      )}

      {editing && (
        <NoteEditor
          key={editing.annotation.id}
          annotation={editing.annotation}
          isNew={editing.isNew}
          onSave={(a) => void saveNote(a)}
          onDelete={() => void deleteAnnotation(editing.annotation)}
          onClose={() => setEditing(null)}
          fill={fillWithAi}
        />
      )}
      {cardDraft && <CardEditor draft={cardDraft} target={{ book }} fill={fillWithAi} onClose={() => setCardDraft(null)} />}
      {ocrOpen && ocrEngine && (
        <OcrDialog
          pageCount={unitCount}
          currentPage={unit}
          recognized={ocrCount}
          progress={ocrJob.progress}
          running={ocrJob.running}
          error={ocrJob.error}
          onStart={(scope) => void startOcr(scope)}
          onStop={() => ocrAbortRef.current?.abort()}
          onClear={() => void clearOcrResults()}
          onClose={() => setOcrOpen(false)}
        />
      )}
      {viewMenu && (
        <ViewSettings
          kind={engine.kind}
          scale={scale}
          textMode={book.format === 'epub' ? undefined : { on: reflow, onChange: (on) => void switchTextMode(on), onSaveCopy: () => void saveTextCopy() }}
          onClose={() => setViewMenu(false)}
        />
      )}
      {aiSettings && <AiSettings onClose={() => setAiSettings(false)} />}
    </div>
  );

  /** Between the pages as they are and their text laid out like an EPUB; the book opens again at the same page. */
  async function switchTextMode(on: boolean) {
    if (on === reflow) return;
    flushPosition();
    setViewMenu(false);
    setReaderNotice(null);
    await db.books.update(bookId, { reflow: on });
    setEngine(null);
    setEpubPos(null);
    setLocationsReady(false);
    setReflowKey((k) => k + 1);
  }

  /** The text mode's EPUB as a book of its own in the library. */
  async function saveTextCopy() {
    const kept = await db.reflows.get(bookId);
    if (!kept || !book) return;
    setViewMenu(false);
    const name = `${book.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'book'} (текст).epub`;
    const result = await importBooks([new File([kept.epub], name, { type: 'application/epub+zip' })]);
    setReaderNotice(result.errors[0] ?? `EPUB-копію «${book.title}» додано до бібліотеки.`);
  }

  function commitSeek() {
    if (seekDraft === null) return;
    epubRef.current?.goToPercent(seekDraft / 1000);
    setSeekDraft(null);
  }
}

function ToolButton({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active?: boolean; onClick(): void }) {
  return (
    <button className={cx('icon-btn', active && 'active')} onClick={onClick} title={label} aria-label={label} aria-pressed={active}>
      <Icon size={18} />
    </button>
  );
}

/** A button of the phone layout's bottom tab bar: icon above a short label. */
function TabButton({ icon: Icon, label, active, accent, onClick }: { icon: LucideIcon; label: string; active?: boolean; accent?: boolean; onClick(): void }) {
  return (
    <button className={cx('tab-btn', active && 'active', accent && 'accent')} onClick={onClick} aria-pressed={active}>
      <Icon size={22} />
      <span>{label}</span>
    </button>
  );
}

function SheetItem({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick(): void }) {
  return (
    <button className="sheet-item" role="menuitem" onClick={onClick}>
      <Icon size={20} />
      <span>{label}</span>
    </button>
  );
}

function PopupButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick(): void }) {
  return (
    <button className="popup-btn" onClick={onClick} title={label} aria-label={label}>
      <Icon size={16} />
    </button>
  );
}
