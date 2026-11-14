import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { StickyNote } from 'lucide-react';
import { findRangesInLayer } from '../engines/search';
import { RenderCancelled, type FixedEngine, type RenderHandle, type TextLayerHandle } from '../engines/types';
import { newTapState, noteGesture, reducedMotion, useTouch, wasTap, zoneOf, type TapZone, type TouchHandlers } from '../lib/gestures';
import { mergeLineRects, textRectsOfRange } from '../lib/notes';
import { clamp, cx } from '../lib/utils';
import { HIGHLIGHT_COLORS, type FixedFlow, type ZoomMode } from '../settings';
import type { Annotation, DrawState, SearchHit, SelectionInfo, Stroke } from '../types';
import { InkSurface } from './InkSurface';

export interface FixedViewApi {
  goToPage(index: number): void;
  next(): void;
  prev(): void;
  getScale(): number;
  /** PageDown / PageUp. Returns false when the view scrolls natively and the key should be left to the browser. */
  step(dir: 1 | -1): boolean;
  /** A swipe made outside the page (on the swipe bar): the page follows the finger by `dx` pixels… */
  drag(dx: number): void;
  /** …and when the finger is lifted after `ms`, it turns or springs back. */
  release(dx: number, ms: number): void;
}

type Anchor = SelectionInfo['anchor'];

interface Props {
  engine: FixedEngine;
  initialPage: number;
  /** One page at a time, turned by swiping, or one continuous scroll. */
  flow: FixedFlow;
  /** Whether a horizontal swipe turns the page. */
  swipe: boolean;
  /** Whether a sideways swipe with two fingers turns the page. */
  swipe2: boolean;
  zoom: ZoomMode;
  annotations: Annotation[];
  ink: Map<number, Stroke[]>;
  draw: DrawState | null;
  searchQuery: string;
  activeHit: SearchHit | null;
  onPageChange(page: number): void;
  onSelection(sel: SelectionInfo | null): void;
  onAnnotationClick(annotation: Annotation, anchor: Anchor): void;
  onInkChange(page: number, strokes: Stroke[], added?: Stroke): void;
  /** Fired on every scroll; anything anchored to viewport coordinates should close. */
  onViewportMove?(): void;
  onScale?(scale: number): void;
  /** Ctrl+wheel / pinch: the user asks to multiply the zoom by this factor. */
  onZoom?(factor: number): void;
  /** A finger tapped the page (not a link, a note or a highlight). */
  onTap?(zone: TapZone): void;
  /** The reader started moving through the book by touch: time to get the bars out of the way. */
  onReadingGesture?(): void;
}

/** Space between the pages that slide past each other while a page is being turned. */
const SLIDE_GAP = 16;
/**
 * Largest page bitmap. iOS refuses canvases above 16.7 million pixels, and phones and tablets
 * have little memory to spare for them, so touch devices get a lower cap.
 */
const MAX_CANVAS_PIXELS = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 9_000_000 : 16_000_000;
const NO_STROKES: Stroke[] = [];
const NO_ANNOTATIONS: Annotation[] = [];
const supportsHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS;

/** Fixed-layout documents (PDF, DjVu): page by page or as one continuous scroll. */
export const PagedView = forwardRef<FixedViewApi, Props>(function PagedView(props, ref) {
  return props.flow === 'paged' ? <Pager {...props} ref={ref} /> : <Scroller {...props} ref={ref} />;
});

// ---------- Shared by both layouts ----------

function useViewport(ref: React.RefObject<HTMLElement | null>) {
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setViewport((v) => (v.w === el.clientWidth && v.h === el.clientHeight ? v : { w: el.clientWidth, h: el.clientHeight }));
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [ref]);
  return viewport;
}

function useEngineEvents(engine: FixedEngine) {
  const [sizesVersion, setSizesVersion] = useState(0);
  // Bumped per page when its text changes after opening, so only that page's text layer is rebuilt.
  const [textVersions, setTextVersions] = useState<Record<number, number>>({});
  useEffect(() => {
    engine.onPageSize = () => setSizesVersion((v) => v + 1);
    engine.onTextChanged = (page) => setTextVersions((v) => ({ ...v, [page]: (v[page] ?? 0) + 1 }));
    return () => {
      engine.onPageSize = undefined;
      engine.onTextChanged = undefined;
    };
  }, [engine]);
  return { sizesVersion, textVersions };
}

function useAnnotationsByPage(annotations: Annotation[]) {
  return useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const a of annotations) {
      const list = map.get(a.unit);
      if (list) list.push(a);
      else map.set(a.unit, [a]);
    }
    return map;
  }, [annotations]);
}

/** Search highlighting through the CSS Custom Highlight API: no DOM changes in the text layer. */
function useSearchHighlights(activeHit: SearchHit | null, goToPage: (page: number) => void) {
  const rangesRef = useRef(new Map<number, Range[]>());
  const activeHitRef = useRef(activeHit);
  activeHitRef.current = activeHit;
  const revealedHitRef = useRef<SearchHit | null>(null);

  const apply = useCallback(() => {
    if (!supportsHighlights) return;
    const all: Range[] = [];
    rangesRef.current.forEach((r) => all.push(...r));
    if (all.length) CSS.highlights.set('zk-search', new Highlight(...all));
    else CSS.highlights.delete('zk-search');

    const hit = activeHitRef.current;
    const pageRanges = hit ? rangesRef.current.get(hit.unit) : undefined;
    const active = pageRanges?.[Math.min(hit?.matchIndex ?? 0, pageRanges.length - 1)];
    if (!active) {
      CSS.highlights.delete('zk-search-active');
      return;
    }
    const highlight = new Highlight(active);
    highlight.priority = 1;
    CSS.highlights.set('zk-search-active', highlight);

    // Bring the active match into view once its page has a text layer.
    const box = active.startContainer.parentElement?.closest<HTMLElement>('.pager-slide, .paged-scroller');
    if (box && hit && revealedHitRef.current !== hit) {
      revealedHitRef.current = hit;
      const rect = active.getBoundingClientRect();
      const frame = box.getBoundingClientRect();
      if (rect.top < frame.top + 40 || rect.bottom > frame.bottom - 40) {
        box.scrollTop += rect.top - frame.top - box.clientHeight * 0.35;
      }
    }
  }, []);

  const registerRanges = useCallback(
    (page: number, ranges: Range[] | null) => {
      if (ranges?.length) rangesRef.current.set(page, ranges);
      else rangesRef.current.delete(page);
      apply();
    },
    [apply],
  );

  /** Scroll to the active match again, after the layout moved the page it is on. */
  const reveal = useCallback(() => {
    revealedHitRef.current = null;
    apply();
  }, [apply]);

  useEffect(() => {
    if (activeHit) goToPage(activeHit.unit);
    apply();
  }, [activeHit, goToPage, apply]);

  useEffect(
    () => () => {
      if (!supportsHighlights) return;
      CSS.highlights.delete('zk-search');
      CSS.highlights.delete('zk-search-active');
    },
    [],
  );

  return { registerRanges, reveal };
}

/** Reports the text selected inside `rootRef`, page by page, so it can be highlighted or annotated. */
function useTextSelection(rootRef: React.RefObject<HTMLElement | null>, propsRef: React.RefObject<Props>) {
  useEffect(() => {
    const root = rootRef.current!;
    let shown = false;
    let recheck: ReturnType<typeof setTimeout> | undefined;
    const report = (sel: SelectionInfo | null) => {
      shown = sel !== null;
      propsRef.current.onSelection(sel);
    };

    const check = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return report(null);
      const selRange = sel.getRangeAt(0);
      if (!root.contains(selRange.commonAncestorContainer)) return;
      const text = sel.toString().replace(/[ \t]+\n/g, '\n').trim();
      const rects = textRectsOfRange(selRange);
      if (!text || !rects.length) return report(null);

      const pages: NonNullable<SelectionInfo['pages']> = [];
      root.querySelectorAll<HTMLElement>('[data-page]').forEach((el) => {
        const box = el.getBoundingClientRect();
        const own = rects.filter((r) => {
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
        });
        if (!own.length) return;
        pages.push({
          page: Number(el.dataset.page),
          rects: mergeLineRects(
            own.map((r) => ({
              x: (r.left - box.left) / box.width,
              y: (r.top - box.top) / box.height,
              w: r.width / box.width,
              h: r.height / box.height,
            })),
          ),
        });
      });
      if (!pages.length) return report(null);
      pages.sort((a, b) => a.page - b.page);
      const top = Math.min(...rects.map((r) => r.top));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      const last = rects[rects.length - 1];
      report({ text, unit: pages[0].page, pages, anchor: { x: last.left + last.width / 2, top, bottom } });
    };

    let pointerHeld = false;
    const onPointerDown = (e: PointerEvent) => {
      pointerHeld = true;
      // While dragging with a mouse, stretch the filler behind the text so the selection does not jump in
      // empty areas. A finger selects by a long press, where a page-sized filler would be selected whole (iOS).
      if (e.pointerType !== 'mouse') return;
      const layer = (e.target as Element | null)?.closest?.('.textLayer');
      layer?.querySelector('.endOfContent')?.classList.add('active');
    };
    const onPointerUp = () => {
      pointerHeld = false;
      root.querySelectorAll('.endOfContent.active').forEach((el) => el.classList.remove('active'));
      setTimeout(check, 10);
    };
    // A long press on a touch screen starts a selection and cancels the pointer instead of releasing it.
    const onPointerCancel = () => {
      pointerHeld = false;
      root.querySelectorAll('.endOfContent.active').forEach((el) => el.classList.remove('active'));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.shiftKey || e.key === 'Shift') check();
    };
    const onSelectionChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) return report(null);
      // Selecting by touch (long press, then dragging the handles) never ends with a pointerup,
      // so the popup follows the selection once it has stopped changing.
      if (pointerHeld) return;
      clearTimeout(recheck);
      recheck = setTimeout(check, 350);
    };
    // The popup is anchored to viewport coordinates: hide it while scrolling, re-anchor when scrolling stops.
    const onScroll = () => {
      const sel = document.getSelection();
      if (!shown && (!sel || sel.isCollapsed)) return;
      if (shown) report(null);
      clearTimeout(recheck);
      recheck = setTimeout(check, 160);
    };

    // Capturing: scroll events do not bubble, and in the page-by-page layout the pages scroll inside the root.
    root.addEventListener('scroll', onScroll, { passive: true, capture: true });
    root.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      clearTimeout(recheck);
      root.removeEventListener('scroll', onScroll, { capture: true });
      root.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [rootRef, propsRef]);
}

/**
 * A finger tap on the view: reported as `onTap`, unless it landed on something of its own. Worked
 * out from the touch itself, because Safari on iPhone does not always follow a tap with a click.
 * Returns whether the tap was taken.
 */
function tapAt(root: HTMLElement, point: { x: number; y: number }, props: Props): boolean {
  if (props.draw) return false;
  const sel = document.getSelection();
  if (sel && !sel.isCollapsed) return false;
  const target = document.elementFromPoint(point.x, point.y);
  if (!target || !root.contains(target) || target.closest('button, a, input')) return false;
  // A highlight under the finger opens its own menu, on the click that follows.
  for (const mark of target.closest('.page')?.querySelectorAll('.mark') ?? []) {
    const box = mark.getBoundingClientRect();
    if (point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom) return false;
  }
  const box = root.getBoundingClientRect();
  const zone = zoneOf((point.x - box.left) / box.width);
  noteGesture('outcome', `дотик: ${zone}`);
  props.onTap?.(zone);
  return true;
}

/** After a tap has been taken, the click the browser sends next must not act on whatever is under the finger now. */
function useGhostClickGuard() {
  const takenAt = useRef(0);
  return {
    taken: () => {
      takenAt.current = Date.now();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (Date.now() - takenAt.current > 500) return;
      e.stopPropagation();
      e.preventDefault();
    },
  };
}

function findPage(tops: number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------- Continuous scroll ----------

interface Layout {
  scale: number;
  pad: number;
  tops: number[];
  total: number;
  contentWidth: number;
}

/** Continuous, virtualized scroll view. */
const Scroller = forwardRef<FixedViewApi, Props>(function Scroller(props, ref) {
  const { engine, zoom, annotations, ink, draw, searchQuery, activeHit } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const viewport = useViewport(scrollerRef);
  const { sizesVersion, textVersions } = useEngineEvents(engine);
  const [range, setRange] = useState<[number, number]>([props.initialPage, props.initialPage]);
  const currentRef = useRef(props.initialPage);
  // The page at the top edge of the viewport and how far into it we are; preserved across zoom/resize.
  const anchorRef = useRef({ page: props.initialPage, frac: 0 });
  const propsRef = useRef(props);
  propsRef.current = props;

  const layout = useMemo<Layout | null>(() => {
    const sizes = engine.pageSizes;
    if (!viewport.w || !sizes.length) return null;
    // On a phone every pixel of width goes to the page.
    const pad = viewport.w < 600 ? 6 : 16;
    const gap = viewport.w < 600 ? 8 : 12;
    let maxW = 1;
    let maxH = 1;
    for (const s of sizes) {
      if (s.width > maxW) maxW = s.width;
      if (s.height > maxH) maxH = s.height;
    }
    const fitWidth = (viewport.w - 2 * pad) / maxW;
    const raw = typeof zoom === 'number' ? zoom : zoom === 'fit-width' ? fitWidth : Math.min(fitWidth, (viewport.h - 2 * pad) / maxH);
    const scale = clamp(raw, 0.1, 8);
    const tops = new Array<number>(sizes.length);
    let y = pad;
    for (let i = 0; i < sizes.length; i++) {
      tops[i] = y;
      y += sizes[i].height * scale + gap;
    }
    return { scale, pad, tops, total: y - gap + pad, contentWidth: Math.max(viewport.w, maxW * scale + 2 * pad) };
    // sizesVersion: page sizes are mutated in place by the engine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, viewport.w, viewport.h, zoom, sizesVersion]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const prevLayoutRef = useRef<Layout | null>(null);
  /** Scroll offsets as last seen, before a new layout made the browser clamp them. */
  const scrollPosRef = useRef({ x: 0, y: 0 });
  /** The point (relative to the scroller) that a pinch or Ctrl+wheel zoom should keep in place. */
  const focalRef = useRef<{ x: number; y: number } | null>(null);

  const syncFromScroll = useCallback(() => {
    const el = scrollerRef.current;
    const l = layoutRef.current;
    if (!el || !l) return;
    const top = el.scrollTop;
    const height = el.clientHeight;
    scrollPosRef.current = { x: el.scrollLeft, y: top };
    const first = findPage(l.tops, top);
    anchorRef.current = { page: first, frac: (top - l.tops[first]) / (engine.pageSizes[first].height * l.scale) };
    const from = findPage(l.tops, top - height);
    const to = findPage(l.tops, top + 2 * height);
    setRange((prev) => (prev[0] === from && prev[1] === to ? prev : [from, to]));
    const current = findPage(l.tops, top + height * 0.35);
    if (current !== currentRef.current) {
      currentRef.current = current;
      propsRef.current.onPageChange(current);
    }
    propsRef.current.onViewportMove?.();
  }, [engine]);

  const scale = layout?.scale;
  useEffect(() => {
    if (scale) propsRef.current.onScale?.(scale);
  }, [scale]);

  useEffect(() => {
    const el = scrollerRef.current!;
    // Keyboard scrolling (arrows, PageUp/PageDown, Space) works as soon as the book opens.
    el.focus({ preventScroll: true });
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const now = Date.now();
      if (now - last < 60) return;
      last = now;
      const box = el.getBoundingClientRect();
      focalRef.current = { x: e.clientX - box.left, y: e.clientY - box.top };
      propsRef.current.onZoom?.(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Keep the same spot in view whenever the layout changes (zoom, resize, corrected page sizes).
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !layout) return;
    const prev = prevLayoutRef.current;
    const focal = focalRef.current;
    prevLayoutRef.current = layout;
    focalRef.current = null;
    if (focal && prev && prev.scale !== layout.scale) {
      // Zoomed by pinch or Ctrl+wheel: what was under the fingers stays under them.
      const y = scrollPosRef.current.y + focal.y;
      const page = findPage(prev.tops, y);
      const size = engine.pageSizes[page];
      const px = (scrollPosRef.current.x + focal.x - (prev.contentWidth - size.width * prev.scale) / 2) / prev.scale;
      const py = (y - prev.tops[page]) / prev.scale;
      el.scrollLeft = (layout.contentWidth - size.width * layout.scale) / 2 + px * layout.scale - focal.x;
      el.scrollTop = layout.tops[page] + py * layout.scale - focal.y;
    } else {
      const { page, frac } = anchorRef.current;
      el.scrollTop = layout.tops[page] + frac * engine.pageSizes[page].height * layout.scale - (frac === 0 ? layout.pad / 2 : 0);
    }
    syncFromScroll();
  }, [layout, engine, syncFromScroll]);

  const goToPage = useCallback(
    (index: number) => {
      const el = scrollerRef.current;
      const l = layoutRef.current;
      const page = clamp(index, 0, engine.unitCount - 1);
      anchorRef.current = { page, frac: 0 };
      if (!el || !l) return;
      el.scrollTop = l.tops[page] - l.pad / 2;
      syncFromScroll();
    },
    [engine, syncFromScroll],
  );

  useImperativeHandle(
    ref,
    () => ({
      goToPage,
      next: () => goToPage(currentRef.current + 1),
      prev: () => goToPage(currentRef.current - 1),
      getScale: () => layoutRef.current?.scale ?? 1,
      step: () => false,
      // A continuous scroll has nothing to drag sideways; a swipe simply moves to the next page.
      drag: () => {},
      release: (dx, ms) => {
        if (Math.abs(dx) > 40 || (Math.abs(dx) > 20 && Math.abs(dx) / Math.max(ms, 1) > 0.3)) goToPage(currentRef.current + (dx < 0 ? 1 : -1));
      },
    }),
    [goToPage],
  );

  const { registerRanges } = useSearchHighlights(activeHit, goToPage);
  useTextSelection(scrollerRef, propsRef);

  // ---- Touch: pinch to zoom, and tell the reader when scrolling by finger starts ----
  const tapRef = useRef(newTapState());
  const ghost = useGhostClickGuard();
  const scrollingRef = useRef(false);
  const touchRef = useRef<TouchHandlers>({});
  touchRef.current = {
    start: () => {
      scrollingRef.current = false;
    },
    move: (_dx, dy) => {
      if (scrollingRef.current || Math.abs(dy) < 24 || propsRef.current.draw) return;
      scrollingRef.current = true;
      propsRef.current.onReadingGesture?.();
    },
    end: (_dx, _dy, ms, point) => {
      if (wasTap(tapRef.current, ms) && tapAt(scrollerRef.current!, point, propsRef.current)) ghost.taken();
    },
    pinch: (factor, center) => {
      if (propsRef.current.draw) return;
      focalRef.current = center;
      propsRef.current.onZoom?.(factor);
    },
    swipe2: (dir) => {
      if (!propsRef.current.swipe2 || propsRef.current.draw) return;
      noteGesture('outcome', `два пальці: гортаю ${dir > 0 ? 'вперед' : 'назад'}`);
      goToPage(currentRef.current + dir);
    },
  };
  useTouch(scrollerRef, touchRef, tapRef);

  const byPage = useAnnotationsByPage(annotations);
  const onAnnotationClick = useCallback((a: Annotation, anchor: Anchor) => propsRef.current.onAnnotationClick(a, anchor), []);
  const onInkChange = useCallback((page: number, strokes: Stroke[], added?: Stroke) => propsRef.current.onInkChange(page, strokes, added), []);

  const pages: React.ReactNode[] = [];
  if (layout) {
    const last = Math.min(range[1], engine.unitCount - 1);
    for (let i = Math.max(0, range[0]); i <= last; i++) {
      const size = engine.pageSizes[i];
      const width = size.width * layout.scale;
      pages.push(
        <PageView
          key={i}
          engine={engine}
          index={i}
          top={layout.tops[i]}
          left={(layout.contentWidth - width) / 2}
          width={width}
          height={size.height * layout.scale}
          scale={layout.scale}
          textVersion={textVersions[i] ?? 0}
          annotations={byPage.get(i) ?? NO_ANNOTATIONS}
          strokes={ink.get(i) ?? NO_STROKES}
          draw={draw}
          searchQuery={searchQuery}
          registerRanges={registerRanges}
          onAnnotationClick={onAnnotationClick}
          onInkChange={onInkChange}
        />,
      );
    }
  }

  return (
    <div
      className={cx('paged-scroller', draw && 'drawing')}
      ref={scrollerRef}
      onScroll={syncFromScroll}
      onClickCapture={ghost.onClickCapture}
      tabIndex={-1}
    >
      <div className="paged-content" style={{ height: layout?.total ?? 0, width: layout?.contentWidth ?? '100%' }}>
        {pages}
      </div>
    </div>
  );
});

// ---------- Page by page ----------

interface Geometry {
  scale: number;
  width: number;
  height: number;
  /** Size of the scrollable area the page sits in: at least the viewport. */
  boxW: number;
  boxH: number;
  left: number;
  top: number;
}

interface Animation {
  /** Jump to the end of the animation now. */
  finish(): void;
  /** Drop the animation and whatever it was going to do. */
  cancel(): void;
}

/**
 * One page on screen at a time. A horizontal swipe drags the page with the finger and slides the
 * next one in; a page taller or wider than the screen scrolls inside its own slide.
 */
const Pager = forwardRef<FixedViewApi, Props>(function Pager(props, ref) {
  const { engine, zoom, annotations, ink, draw, searchQuery, activeHit } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const slidesRef = useRef(new Map<number, HTMLDivElement>());
  const viewport = useViewport(rootRef);
  const { sizesVersion, textVersions } = useEngineEvents(engine);
  const [current, setCurrent] = useState(props.initialPage);
  const currentRef = useRef(current);
  currentRef.current = current;
  const propsRef = useRef(props);
  propsRef.current = props;
  const animationRef = useRef<Animation | null>(null);

  // A phone gives the whole screen to the page; larger screens keep a margin around it.
  const pad = viewport.w < 600 ? 0 : 12;
  const geometry = useCallback(
    (i: number): Geometry | null => {
      const size = engine.pageSizes[i];
      if (!size || !viewport.w || !viewport.h) return null;
      const fitWidth = (viewport.w - 2 * pad) / size.width;
      const fitHeight = (viewport.h - 2 * pad) / size.height;
      const raw = typeof zoom === 'number' ? zoom : zoom === 'fit-width' ? fitWidth : Math.min(fitWidth, fitHeight);
      const scale = clamp(raw, 0.1, 8);
      const width = size.width * scale;
      const height = size.height * scale;
      const boxW = Math.max(viewport.w, Math.round(width + 2 * pad));
      const boxH = Math.max(viewport.h, Math.round(height + 2 * pad));
      return { scale, width, height, boxW, boxH, left: (boxW - width) / 2, top: (boxH - height) / 2 };
    },
    // sizesVersion: page sizes are mutated in place by the engine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, viewport.w, viewport.h, zoom, pad, sizesVersion],
  );
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  // ---- Turning pages ----
  const turn = useCallback(
    (dir: 1 | -1): boolean => {
      animationRef.current?.finish();
      const target = currentRef.current + dir;
      const track = trackRef.current;
      const root = rootRef.current;
      if (!track || !root || target < 0 || target >= engine.unitCount) return false;
      const commit = () => {
        track.style.transition = '';
        // The slides shift and the track snaps back within the same frame, so nothing jumps.
        flushSync(() => setCurrent(target));
        track.style.transform = '';
      };
      if (reducedMotion()) {
        commit();
        return true;
      }
      const stop = () => {
        clearTimeout(timer);
        track.removeEventListener('transitionend', onEnd);
        animationRef.current = null;
      };
      const onEnd = (e: TransitionEvent) => {
        if (e.target !== track) return;
        stop();
        commit();
      };
      // The timer covers the cases where no transition runs at all (a hidden tab, for one).
      const timer = setTimeout(() => {
        stop();
        commit();
      }, 340);
      animationRef.current = {
        finish: () => {
          stop();
          commit();
        },
        cancel: () => {
          stop();
          track.style.transition = '';
          track.style.transform = '';
        },
      };
      track.addEventListener('transitionend', onEnd);
      void track.offsetWidth;
      track.style.transition = 'transform 240ms cubic-bezier(0.22, 0.8, 0.24, 1)';
      track.style.transform = `translate3d(${-dir * (root.clientWidth + SLIDE_GAP)}px, 0, 0)`;
      return true;
    },
    [engine],
  );

  /** Lets a page that was dragged, but not far enough, slide back into place. */
  const settle = useCallback(() => {
    const track = trackRef.current;
    if (!track || !track.style.transform) return;
    const clear = () => {
      clearTimeout(timer);
      track.removeEventListener('transitionend', onEnd);
      if (animationRef.current === handle) animationRef.current = null;
      track.style.transition = '';
      track.style.transform = '';
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === track) clear();
    };
    const timer = setTimeout(clear, 260);
    const handle: Animation = { finish: clear, cancel: clear };
    animationRef.current = handle;
    track.addEventListener('transitionend', onEnd);
    track.style.transition = 'transform 180ms ease-out';
    track.style.transform = 'translate3d(0, 0, 0)';
  }, []);

  const goToPage = useCallback(
    (index: number) => {
      animationRef.current?.cancel();
      setCurrent(clamp(index, 0, engine.unitCount - 1));
    },
    [engine],
  );

  /** A swipe on the swipe bar drives the same strip of pages as a swipe on the page itself. */
  const drag = useCallback(
    (dx: number) => {
      const track = trackRef.current;
      if (!track) return;
      animationRef.current?.finish();
      const target = currentRef.current + (dx < 0 ? 1 : -1);
      const exists = target >= 0 && target < engine.unitCount;
      track.style.transition = '';
      track.style.transform = `translate3d(${exists ? dx : dx * 0.3}px, 0, 0)`;
    },
    [engine],
  );
  const release = useCallback(
    (dx: number, ms: number) => {
      // A swipe on the bar is deliberate, so it needs less travel than one on the page.
      const far = Math.abs(dx) > (rootRef.current?.clientWidth ?? 300) * 0.18;
      const fast = Math.abs(dx) > 20 && Math.abs(dx) / Math.max(ms, 1) > 0.3;
      const turned = (far || fast) && turn(dx < 0 ? 1 : -1);
      noteGesture('outcome', turned ? `зона свайпу: гортаю ${dx < 0 ? 'вперед' : 'назад'}` : 'зона свайпу: закороткий рух');
      if (!turned) settle();
    },
    [turn, settle],
  );

  const step = useCallback(
    (dir: 1 | -1): boolean => {
      const el = slidesRef.current.get(currentRef.current);
      if (!el) return true;
      const room = dir > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop;
      if (room > 2) el.scrollBy({ top: dir * el.clientHeight * 0.9, behavior: reducedMotion() ? 'auto' : 'smooth' });
      else turn(dir);
      return true;
    },
    [turn],
  );

  useImperativeHandle(
    ref,
    () => ({
      goToPage,
      next: () => void turn(1),
      prev: () => void turn(-1),
      getScale: () => geometryRef.current(currentRef.current)?.scale ?? 1,
      step,
      drag,
      release,
    }),
    [goToPage, turn, step, drag, release],
  );

  const { registerRanges, reveal } = useSearchHighlights(activeHit, goToPage);
  useTextSelection(rootRef, propsRef);

  // ---- Where each slide is scrolled to ----
  /** Scroll offsets of the current slide as last seen, before a new layout made the browser clamp them. */
  const posRef = useRef({ x: 0, y: 0 });
  const placedRef = useRef<{ page: number; geo: Geometry } | null>(null);
  /** The point (relative to the view) that a pinch or Ctrl+wheel zoom should keep in place. */
  const focalRef = useRef<{ x: number; y: number } | null>(null);
  const lastScrollRef = useRef(0);

  useLayoutEffect(() => {
    for (const [i, el] of slidesRef.current) {
      const geo = geometry(i);
      if (!geo) continue;
      if (i !== current) {
        // A neighbour waits at its top, centred, ready to slide in.
        el.scrollTop = 0;
        el.scrollLeft = (geo.boxW - viewport.w) / 2;
        continue;
      }
      const placed = placedRef.current;
      if (placed?.page !== i) {
        el.scrollTop = 0;
        el.scrollLeft = (geo.boxW - viewport.w) / 2;
        reveal();
      } else if (placed.geo.scale !== geo.scale || placed.geo.boxW !== geo.boxW || placed.geo.boxH !== geo.boxH) {
        // Zoom or resize: what was under the fingers (or in the middle of the screen) stays there.
        const f = focalRef.current ?? { x: viewport.w / 2, y: viewport.h / 2 };
        const px = (posRef.current.x + f.x - placed.geo.left) / placed.geo.scale;
        const py = (posRef.current.y + f.y - placed.geo.top) / placed.geo.scale;
        el.scrollLeft = geo.left + px * geo.scale - f.x;
        el.scrollTop = geo.top + py * geo.scale - f.y;
      }
      posRef.current = { x: el.scrollLeft, y: el.scrollTop };
      placedRef.current = { page: i, geo };
    }
    focalRef.current = null;
  }, [current, geometry, viewport.w, viewport.h, reveal]);

  const reportedRef = useRef(props.initialPage);
  useEffect(() => {
    if (reportedRef.current !== current) {
      reportedRef.current = current;
      propsRef.current.onPageChange(current);
    }
    propsRef.current.onViewportMove?.();
    // Arrow keys and PageDown scroll the page that is on screen, unless the user is typing somewhere.
    const active = document.activeElement;
    if (!active || active === document.body || rootRef.current?.contains(active)) {
      slidesRef.current.get(current)?.focus({ preventScroll: true });
    }
  }, [current]);

  const scale = geometry(current)?.scale;
  useEffect(() => {
    if (scale) propsRef.current.onScale?.(scale);
  }, [scale]);

  // ---- Mouse wheel and trackpad ----
  useEffect(() => {
    const root = rootRef.current!;
    let lastZoom = 0;
    let lastTurn = 0;
    const onWheel = (e: WheelEvent) => {
      const now = Date.now();
      if (e.ctrlKey) {
        e.preventDefault();
        if (now - lastZoom < 60) return;
        lastZoom = now;
        const box = root.getBoundingClientRect();
        focalRef.current = { x: e.clientX - box.left, y: e.clientY - box.top };
        propsRef.current.onZoom?.(e.deltaY < 0 ? 1.1 : 1 / 1.1);
        return;
      }
      const el = slidesRef.current.get(currentRef.current);
      if (!el) return;
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const delta = horizontal ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 12) return;
      const room = horizontal
        ? delta > 0
          ? el.scrollWidth - el.clientWidth - el.scrollLeft
          : el.scrollLeft
        : delta > 0
          ? el.scrollHeight - el.clientHeight - el.scrollTop
          : el.scrollTop;
      // The page itself still scrolls that way; and the tail of that scroll must not turn the page.
      if (room > 1 || now - lastScrollRef.current < 250 || now - lastTurn < 400) return;
      lastTurn = now;
      turn(delta > 0 ? 1 : -1);
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [turn]);

  // ---- Touch: swipe to turn, pinch to zoom ----
  const tapRef = useRef(newTapState());
  const ghost = useGhostClickGuard();
  const dragRef = useRef<{ axis: 'x' | 'y' | null; pannable: boolean; atLeft: boolean; atRight: boolean } | null>(null);
  const touchRef = useRef<TouchHandlers>({});
  touchRef.current = {
    start: () => {
      animationRef.current?.finish();
      const el = slidesRef.current.get(currentRef.current);
      if (!el || propsRef.current.draw) {
        dragRef.current = null;
        return;
      }
      dragRef.current = {
        axis: null,
        // A zoomed-in page pans under the finger; it turns only when flicked past its edge.
        pannable: el.scrollWidth > el.clientWidth + 1,
        atLeft: el.scrollLeft <= 1,
        atRight: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
      };
    },
    move: (dx, dy) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        const sel = document.getSelection();
        const selecting = tapRef.current.hadSelection || Boolean(sel && !sel.isCollapsed);
        drag.axis = Math.abs(dx) > Math.abs(dy) * 1.2 && !selecting ? 'x' : 'y';
        if (drag.axis === 'y') propsRef.current.onReadingGesture?.();
      }
      if (drag.axis !== 'x' || drag.pannable || !propsRef.current.swipe) return;
      const target = currentRef.current + (dx < 0 ? 1 : -1);
      const exists = target >= 0 && target < engine.unitCount;
      // Past the first or the last page the book resists instead of following the finger.
      trackRef.current!.style.transform = `translate3d(${exists ? dx : dx * 0.3}px, 0, 0)`;
    },
    end: (dx, _dy, ms, point) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (wasTap(tapRef.current, ms)) {
        if (tapAt(rootRef.current!, point, propsRef.current)) ghost.taken();
        return;
      }
      if (!drag || drag.axis !== 'x' || !propsRef.current.swipe) return;
      const dir = dx < 0 ? 1 : -1;
      if (drag.pannable) {
        if (ms < 500 && Math.abs(dx) > 60 && (dir > 0 ? drag.atRight : drag.atLeft) && turn(dir)) propsRef.current.onReadingGesture?.();
        return;
      }
      const far = Math.abs(dx) > rootRef.current!.clientWidth * 0.28;
      const fast = Math.abs(dx) > 24 && Math.abs(dx) / Math.max(ms, 1) > 0.4;
      const turned = (far || fast) && turn(dir);
      noteGesture('outcome', turned ? `свайп: гортаю ${dir > 0 ? 'вперед' : 'назад'}` : 'свайп закороткий — повертаю сторінку');
      if (turned) propsRef.current.onReadingGesture?.();
      else settle();
    },
    cancel: () => {
      dragRef.current = null;
      settle();
    },
    pinch: (factor, center) => {
      if (propsRef.current.draw) return;
      focalRef.current = center;
      propsRef.current.onZoom?.(factor);
    },
    swipe2: (dir) => {
      if (!propsRef.current.swipe2 || propsRef.current.draw) return;
      const turned = turn(dir);
      noteGesture('outcome', turned ? `два пальці: гортаю ${dir > 0 ? 'вперед' : 'назад'}` : 'два пальці: далі сторінок немає');
      if (turned) propsRef.current.onReadingGesture?.();
    },
  };
  useTouch(rootRef, touchRef, tapRef);

  const byPage = useAnnotationsByPage(annotations);
  const onAnnotationClick = useCallback((a: Annotation, anchor: Anchor) => propsRef.current.onAnnotationClick(a, anchor), []);
  const onInkChange = useCallback((page: number, strokes: Stroke[], added?: Stroke) => propsRef.current.onInkChange(page, strokes, added), []);

  const slides: React.ReactNode[] = [];
  for (let i = Math.max(0, current - 1); i <= Math.min(engine.unitCount - 1, current + 1); i++) {
    const geo = geometry(i);
    slides.push(
      <div
        key={i}
        className="pager-slide"
        ref={(el) => {
          if (el) slidesRef.current.set(i, el);
          else slidesRef.current.delete(i);
        }}
        tabIndex={-1}
        aria-hidden={i !== current}
        style={{
          transform: `translateX(calc(${i - current} * (100% + ${SLIDE_GAP}px)))`,
          touchAction: geo && geo.boxW > viewport.w + 1 ? 'pan-x pan-y' : 'pan-y',
        }}
        onScroll={(e) => {
          lastScrollRef.current = Date.now();
          if (i === currentRef.current) posRef.current = { x: e.currentTarget.scrollLeft, y: e.currentTarget.scrollTop };
          propsRef.current.onViewportMove?.();
        }}
      >
        {geo && (
          <div className="pager-box" style={{ width: geo.boxW, height: geo.boxH }}>
            <PageView
              engine={engine}
              index={i}
              top={geo.top}
              left={geo.left}
              width={geo.width}
              height={geo.height}
              scale={geo.scale}
              textVersion={textVersions[i] ?? 0}
              annotations={byPage.get(i) ?? NO_ANNOTATIONS}
              strokes={ink.get(i) ?? NO_STROKES}
              draw={draw}
              searchQuery={searchQuery}
              registerRanges={registerRanges}
              onAnnotationClick={onAnnotationClick}
              onInkChange={onInkChange}
            />
          </div>
        )}
      </div>,
    );
  }

  return (
    <div className={cx('pager', draw && 'drawing')} ref={rootRef} onClickCapture={ghost.onClickCapture}>
      <div className="pager-track" ref={trackRef}>
        {slides}
      </div>
    </div>
  );
});

// ---------- One page ----------

interface PageProps {
  engine: FixedEngine;
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  scale: number;
  textVersion: number;
  annotations: Annotation[];
  strokes: Stroke[];
  draw: DrawState | null;
  searchQuery: string;
  registerRanges(page: number, ranges: Range[] | null): void;
  onAnnotationClick(annotation: Annotation, anchor: Anchor): void;
  onInkChange(page: number, strokes: Stroke[], added?: Stroke): void;
}

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

const PageView = memo(function PageView(props: PageProps) {
  const { engine, index, width, height, scale, textVersion, annotations, strokes, draw, searchQuery, registerRanges } = props;
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const textHandleRef = useRef<TextLayerHandle | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const [textReady, setTextReady] = useState(0);
  const [failed, setFailed] = useState(false);
  const hasImageRef = useRef(false);

  const pixelWidth = Math.round(width);
  const pixelHeight = Math.round(height);

  // Page image. The previous canvas stays (stretched by CSS) until the sharper one is ready.
  useEffect(() => {
    let handle: RenderHandle | null = null;
    let disposed = false;
    const start = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      let w = Math.round(pixelWidth * dpr);
      let h = Math.round(pixelHeight * dpr);
      if (w * h > MAX_CANVAS_PIXELS) {
        const k = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
        w = Math.floor(w * k);
        h = Math.floor(h * k);
      }
      const canvas = document.createElement('canvas');
      handle = engine.render(index, canvas, w, h);
      handle.promise.then(
        () => {
          if (disposed) return;
          canvasHostRef.current?.replaceChildren(canvas);
          hasImageRef.current = true;
          setFailed(false);
        },
        (err) => {
          if (disposed || err instanceof RenderCancelled) return;
          console.error(`Не вдалося відобразити сторінку ${index + 1}`, err);
          setFailed(true);
        },
      );
    };
    // A short delay skips pages that only fly past while scrolling; a longer one debounces zooming.
    const timer = setTimeout(start, hasImageRef.current ? 180 : 40);
    return () => {
      disposed = true;
      clearTimeout(timer);
      handle?.cancel();
    };
  }, [engine, index, pixelWidth, pixelHeight]);

  // Selectable text over the image; built once and rescaled through a CSS variable.
  useEffect(() => {
    const container = textRef.current!;
    let disposed = false;
    // Start from a clean element: a previous build (e.g. the PDF's own layer before OCR) leaves
    // inline sizes and variables behind that would distort the next one.
    container.replaceChildren();
    container.removeAttribute('style');
    engine
      .buildTextLayer(index, container, scaleRef.current)
      .then((handle) => {
        if (disposed) return handle.cancel();
        if (!container.querySelector('.endOfContent')) {
          const end = document.createElement('div');
          end.className = 'endOfContent';
          container.append(end);
        }
        textHandleRef.current = handle;
        handle.update(scaleRef.current);
        setTextReady((v) => v + 1);
      })
      .catch(() => {
        // No text layer (scanned page) — the page is still readable.
      });
    return () => {
      disposed = true;
      textHandleRef.current?.cancel();
      textHandleRef.current = null;
    };
  }, [engine, index, textVersion]);

  useEffect(() => {
    textHandleRef.current?.update(scale);
  }, [scale]);

  useEffect(() => {
    if (!textReady || !searchQuery || !textRef.current) return;
    registerRanges(index, findRangesInLayer(textRef.current, searchQuery));
    return () => registerRanges(index, null);
  }, [textReady, searchQuery, index, registerRanges]);

  const marks = annotations.filter((a) => a.type !== 'bookmark' && a.rects?.length);
  const pageNotes = annotations.filter((a) => a.type === 'note' && !a.rects?.length);
  const bookmarked = annotations.some((a) => a.type === 'bookmark');

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (draw || !marks.length) return;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
    for (const a of marks) {
      const hit = a.rects!.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
      if (!hit) continue;
      // Tells the view around the page that this tap is spoken for: it must not turn the page.
      e.preventDefault();
      props.onAnnotationClick(a, {
        x: box.left + (hit.x + hit.w / 2) * box.width,
        top: box.top + hit.y * box.height,
        bottom: box.top + (hit.y + hit.h) * box.height,
      });
      return;
    }
  };

  return (
    <div className="page" data-page={index} style={{ top: props.top, left: props.left, width, height }} onClick={onClick}>
      <div className="page-canvas" ref={canvasHostRef} />
      {failed && <div className="page-error">Не вдалося відобразити сторінку {index + 1}</div>}
      <div className="page-marks">
        {marks.map((a) =>
          a.rects!.map((r, i) => (
            <div
              key={`${a.id}:${i}`}
              className={cx('mark', a.type === 'note' && 'mark-note')}
              style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h), background: HIGHLIGHT_COLORS[a.color] }}
            />
          )),
        )}
      </div>
      <div className="textLayer" ref={textRef} />
      <InkSurface className="page-ink" strokes={strokes} tool={draw} onChange={(next, added) => props.onInkChange(index, next, added)} />
      {bookmarked && <div className="page-bookmark" title="Закладка" />}
      {pageNotes.length > 0 && (
        <div className="page-notes">
          {pageNotes.map((a) => (
            <button
              key={a.id}
              className="page-note-pin"
              style={{ background: HIGHLIGHT_COLORS[a.color] }}
              title={a.text || 'Нотатка'}
              onClick={(e) => {
                e.stopPropagation();
                const box = e.currentTarget.getBoundingClientRect();
                props.onAnnotationClick(a, { x: box.left + box.width / 2, top: box.top, bottom: box.bottom });
              }}
            >
              <StickyNote size={14} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
