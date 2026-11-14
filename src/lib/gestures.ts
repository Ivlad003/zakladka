import { useEffect, useSyncExternalStore } from 'react';

/** Which third of the page a finger tapped: the sides turn pages, the middle shows or hides the bars. */
export type TapZone = 'left' | 'center' | 'right';

export const zoneOf = (fraction: number): TapZone => (fraction < 0.28 ? 'left' : fraction > 0.72 ? 'right' : 'center');

export const isTouchDevice = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => matchMedia(query).matches,
  );
}

/** What the last touch on a view amounted to; read by the click that follows a tap. */
export interface TapState {
  endedAt: number;
  moved: boolean;
  hadSelection: boolean;
}

export const newTapState = (): TapState => ({ endedAt: 0, moved: false, hadSelection: false });

/** True when the click being handled is a plain finger tap: no drag, no selection to dismiss. */
export const isTap = (state: TapState): boolean => Date.now() - state.endedAt < 700 && !state.moved && !state.hadSelection;

export interface TouchHandlers {
  /** One finger went down. */
  start?(): void;
  /** That finger moved by (dx, dy) since it went down. */
  move?(dx: number, dy: number): void;
  /** It was lifted after `ms` milliseconds, at `point`. */
  end?(dx: number, dy: number, ms: number, point: { x: number; y: number }): void;
  /** The gesture was taken over: a second finger, or the system. */
  cancel?(): void;
  /** Two fingers moved apart or together: multiply the zoom by `factor`, around `center` (relative to the element). */
  pinch?(factor: number, center: { x: number; y: number }): void;
}

export interface TouchOptions {
  /** Where a touch is, in coordinates that stay put during the gesture. Needed inside a frame that moves with the finger. */
  point?(touch: Touch): { x: number; y: number };
  /** Whether text is selected in the document the touches land in. */
  hasSelection?(): boolean;
}

/**
 * One-finger drags and two-finger pinches on an element or a document. Touch events (not pointer
 * events) on purpose: they keep arriving while the browser scrolls natively, so a swipe can be
 * told from a scroll without taking scrolling away from the browser.
 */
export function attachTouch(
  target: HTMLElement | Document,
  handlers: { readonly current: TouchHandlers },
  tap: { current: TapState },
  options: TouchOptions = {},
): () => void {
  let one: { x: number; y: number; t: number } | null = null;
  let pinch: { distance: number; applied: number; at: number } | null = null;
  let multi = false;
  const point = options.point ?? ((t: Touch) => ({ x: t.clientX, y: t.clientY }));
  const distance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const hasSelection =
    options.hasSelection ??
    (() => {
      const sel = document.getSelection();
      return Boolean(sel && !sel.isCollapsed);
    });

  const onStart = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      multi = false;
      one = { ...point(e.touches[0]), t: performance.now() };
      tap.current = { endedAt: 0, moved: false, hadSelection: hasSelection() };
      noteGesture('start');
      handlers.current.start?.();
    } else if (e.touches.length === 2) {
      if (one) handlers.current.cancel?.();
      one = null;
      multi = true;
      tap.current.moved = true;
      pinch = { distance: distance(e.touches[0], e.touches[1]), applied: 1, at: 0 };
    }
  };

  const onMove = (e: TouchEvent) => {
    if (pinch && e.touches.length >= 2) {
      const now = performance.now();
      if (now - pinch.at < 50 || pinch.distance < 10) return;
      const factor = distance(e.touches[0], e.touches[1]) / pinch.distance;
      const step = factor / pinch.applied;
      if (Math.abs(step - 1) < 0.03) return;
      pinch.at = now;
      pinch.applied = factor;
      const box = target instanceof HTMLElement ? target.getBoundingClientRect() : { left: 0, top: 0 };
      handlers.current.pinch?.(step, {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - box.left,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - box.top,
      });
      return;
    }
    if (!one || e.touches.length !== 1) return;
    const p = point(e.touches[0]);
    const dx = p.x - one.x;
    const dy = p.y - one.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) tap.current.moved = true;
    noteGesture('move', `dx ${Math.round(dx)}, dy ${Math.round(dy)}`);
    handlers.current.move?.(dx, dy);
  };

  const onEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) pinch = null;
    if (e.touches.length > 0) return;
    tap.current.endedAt = Date.now();
    if (one && !multi) {
      const p = point(e.changedTouches[0]);
      const ms = performance.now() - one.t;
      noteGesture('end', `dx ${Math.round(p.x - one.x)}, dy ${Math.round(p.y - one.y)}, ${Math.round(ms)} мс`);
      handlers.current.end?.(p.x - one.x, p.y - one.y, ms, p);
    }
    one = null;
  };

  const onCancel = () => {
    noteGesture('cancel');
    pinch = null;
    if (one) handlers.current.cancel?.();
    one = null;
    tap.current.moved = true;
  };

  const el = target as HTMLElement;
  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: true });
  el.addEventListener('touchend', onEnd, { passive: true });
  el.addEventListener('touchcancel', onCancel, { passive: true });
  return () => {
    el.removeEventListener('touchstart', onStart);
    el.removeEventListener('touchmove', onMove);
    el.removeEventListener('touchend', onEnd);
    el.removeEventListener('touchcancel', onCancel);
  };
}

export function useTouch(ref: React.RefObject<HTMLElement | null>, handlers: React.RefObject<TouchHandlers>, tap: React.RefObject<TapState>): void {
  useEffect(() => {
    const root = ref.current;
    if (root) return attachTouch(root, handlers, tap);
  }, [ref, handlers, tap]);
}

/** A finger tap as opposed to a drag, a long press or a tap that only dismisses a selection. */
export const wasTap = (state: TapState, ms: number): boolean => !state.moved && !state.hadSelection && ms < 500;

// ---- A readout of what the touch handling sees, for finding out why a gesture does nothing ----

export interface GestureReadout {
  start: number;
  move: number;
  end: number;
  cancel: number;
  last: string;
  /** What the reader decided to do with the last gesture. */
  outcome: string;
}

let readout: GestureReadout = { start: 0, move: 0, end: 0, cancel: 0, last: '', outcome: '' };
const readoutListeners = new Set<() => void>();

export function noteGesture(kind: 'start' | 'move' | 'end' | 'cancel' | 'outcome', detail = ''): void {
  if (!readoutListeners.size) return;
  readout = kind === 'outcome' ? { ...readout, outcome: detail } : { ...readout, [kind]: readout[kind] + 1, last: detail || readout.last };
  readoutListeners.forEach((l) => l());
}

export function useGestureReadout(): GestureReadout {
  return useSyncExternalStore(
    (listener) => {
      readoutListeners.add(listener);
      return () => readoutListeners.delete(listener);
    },
    () => readout,
  );
}

/**
 * Keeps the app exactly as tall as the part of the screen that is really visible, so the on-screen
 * keyboard pushes the layout up the way it does in a native app instead of scrolling the page.
 */
export function trackVisibleHeight(): void {
  const viewport = window.visualViewport;
  if (!viewport || !isTouchDevice) return;
  const apply = () => {
    document.documentElement.style.setProperty('--app-height', `${Math.round(viewport.height)}px`);
    // iOS scrolls the document to reveal a focused field even when nothing on the page can scroll.
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  };
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);
  apply();
}
