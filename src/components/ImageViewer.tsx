import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import { reducedMotion } from '../lib/gestures';
import { clamp } from '../lib/utils';

/** How far a picture can be enlarged, counting from the size at which it fits the screen. */
const MAX_ZOOM = 8;
/** A picture smaller than the screen is not stretched further than this to fill it. */
const MAX_FIT = 3;
/** One press of a zoom button. */
const BUTTON_STEP = 1.6;
const DOUBLE_TAP_ZOOM = 2.5;
/** A swipe down this long, on a picture shown whole, closes the viewer. */
const PULL_TO_CLOSE = 90;
/**
 * A browser follows a finger tap with a click of its own making. The tap that opened the viewer was
 * made on the page; its click may land on the viewer, which covers the page by then, and must not
 * press anything in it.
 */
const DEAF_FOR = 400;

interface Point {
  x: number;
  y: number;
}

/** `zoom` 1 shows the picture whole; (x, y) is how far its middle is from the middle of the screen. */
interface View extends Point {
  zoom: number;
}

type Grip =
  | { kind: 'drag'; from: Point; view: View; axis: 'x' | 'y' | null }
  /** `middle`: where the fingers' midpoint was when they took hold, from the middle of the screen. */
  | { kind: 'pinch'; span: number; middle: Point; view: View };

interface Props {
  src: string;
  alt?: string;
  /** What shows through a picture with see-through parts: the colour of the page it stood on. */
  background: string;
  onClose(): void;
}

/**
 * A picture from a book, opened to be looked at closely: two fingers (or the wheel, or the buttons)
 * enlarge it, a finger moves it around, a double tap zooms in and back. A tap beside the picture, a
 * swipe down, Esc or the cross closes it.
 */
export function ImageViewer({ src, alt, background, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  /** Size of the picture at zoom 1; null until it has loaded. */
  const fitRef = useRef<{ w: number; h: number } | null>(null);
  const viewRef = useRef<View>({ zoom: 1, x: 0, y: 0 });
  /** How far a swipe down has pulled the picture, px. */
  const pulledRef = useRef(0);
  const pointersRef = useRef(new Map<number, Point>());
  const gripRef = useRef<Grip | null>(null);
  /** The press under way, or the one that has just ended: whether it stayed a tap. */
  const pressRef = useRef({ at: 0, moved: false, many: false });
  const lastTapRef = useRef<(Point & { at: number }) | null>(null);
  const openedAtRef = useRef(performance.now());
  const [percent, setPercent] = useState(100);
  const [state, setState] = useState<'loading' | 'shown' | 'failed'>('loading');

  const deaf = () => performance.now() - openedAtRef.current < DEAF_FOR;

  /** Puts the picture where `next` says, as far as the edges of the screen allow. */
  const place = useCallback((next: View, animate = false) => {
    const stage = stageRef.current;
    const img = imgRef.current;
    const fit = fitRef.current;
    if (!stage || !img || !fit) return;
    const zoom = clamp(next.zoom, 1, MAX_ZOOM);
    const w = fit.w * zoom;
    const h = fit.h * zoom;
    // A picture smaller than the screen stays in the middle; a larger one cannot be dragged off it.
    const reachX = Math.max(0, (w - stage.clientWidth) / 2);
    const reachY = Math.max(0, (h - stage.clientHeight) / 2);
    const view = { zoom, x: clamp(next.x, -reachX, reachX), y: clamp(next.y, -reachY, reachY) };
    viewRef.current = view;
    img.style.transition = animate && !reducedMotion() ? 'width 0.2s ease, height 0.2s ease, transform 0.2s ease' : '';
    // The size itself changes, not a scale laid over the picture: the browser then draws it anew at
    // every size and it stays sharp, where a scaled layer may be shown blurred (a vector drawing most of all).
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    // Whole pixels: a picture standing between two of them is drawn soft.
    img.style.transform = `translate(${Math.round(stage.clientWidth / 2 + view.x - w / 2)}px, ${Math.round(stage.clientHeight / 2 + view.y - h / 2 + pulledRef.current)}px)`;
    // The further the picture is pulled down, the more of the book shows through.
    rootRef.current?.style.setProperty('--veil', String(1 - Math.min(0.6, pulledRef.current / 400)));
    setPercent(Math.round(zoom * 100));
  }, []);

  /** Works out the size at which the picture fits the screen: when it has loaded, and when the screen changes. */
  const fit = useCallback(() => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img || !img.complete || !stage.clientWidth || !stage.clientHeight) return;
    // A vector drawing may come without a size of its own.
    const w = img.naturalWidth || 800;
    const h = img.naturalHeight || 600;
    const k = Math.min(stage.clientWidth / w, stage.clientHeight / h, MAX_FIT);
    fitRef.current = { w: w * k, h: h * k };
    place(viewRef.current);
  }, [place]);

  /** A point of the screen, counted from the middle of the stage. */
  const fromMiddle = (x: number, y: number): Point => {
    const box = stageRef.current!.getBoundingClientRect();
    return { x: x - box.left - box.width / 2, y: y - box.top - box.height / 2 };
  };

  /** Changes the zoom so that the spot of the picture under `p` stays under it. */
  const zoomAt = useCallback(
    (wanted: number, p: Point, animate = false) => {
      const v = viewRef.current;
      const zoom = clamp(wanted, 1, MAX_ZOOM);
      const k = zoom / v.zoom;
      place({ zoom, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k }, animate);
    },
    [place],
  );

  useLayoutEffect(() => {
    const stage = stageRef.current!;
    // Keys must come here, not to the page of the book the reader has just clicked in.
    rootRef.current?.focus({ preventScroll: true });
    // The picture may have come from the cache before anyone was listening for it.
    if (imgRef.current?.complete && imgRef.current.naturalWidth) {
      fit();
      setState('shown');
    }
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // A pinch on a trackpad arrives as a wheel with Ctrl held, in much smaller steps.
      const perPixel = e.ctrlKey ? 0.01 : 0.0015;
      zoomAt(viewRef.current.zoom * Math.exp(-e.deltaY * perPixel * (e.deltaMode === 1 ? 33 : 1)), fromMiddle(e.clientX, e.clientY));
    };
    // Safari's own pinch, of the whole page, must not start under the fingers.
    const noGesture = (e: Event) => e.preventDefault();
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('gesturestart', noGesture);
    stage.addEventListener('gesturechange', noGesture);
    return () => {
      observer.disconnect();
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('gesturestart', noGesture);
      stage.removeEventListener('gesturechange', noGesture);
    };
  }, [fit, zoomAt]);

  // ---- Fingers and the mouse ----
  /** Takes hold of the picture anew with the fingers that are down now. */
  const grip = () => {
    const points = [...pointersRef.current.values()];
    const view = { ...viewRef.current };
    if (points.length >= 2) {
      const [a, b] = points;
      gripRef.current = { kind: 'pinch', span: Math.hypot(a.x - b.x, a.y - b.y) || 1, middle: fromMiddle((a.x + b.x) / 2, (a.y + b.y) / 2), view };
    } else if (points.length === 1) {
      gripRef.current = { kind: 'drag', from: { ...points[0] }, view, axis: null };
    } else {
      gripRef.current = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // The first finger of a touch: whatever was left of an earlier one (a lift that never arrived) is forgotten.
    if (e.isPrimary) pointersRef.current.clear();
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      stageRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is gone already; its moves simply stop coming.
    }
    if (pointersRef.current.size === 1) pressRef.current = { at: performance.now(), moved: false, many: false };
    else pressRef.current.many = true;
    grip();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const point = pointersRef.current.get(e.pointerId);
    const held = gripRef.current;
    if (!point || !held) return;
    point.x = e.clientX;
    point.y = e.clientY;
    const points = [...pointersRef.current.values()];
    if (held.kind === 'pinch') {
      if (points.length < 2) return;
      const [a, b] = points;
      const zoom = clamp((held.view.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / held.span, 1, MAX_ZOOM);
      const k = zoom / held.view.zoom;
      const middle = fromMiddle((a.x + b.x) / 2, (a.y + b.y) / 2);
      // The spot of the picture that was between the fingers stays between them, wherever they go.
      place({ zoom, x: middle.x - (held.middle.x - held.view.x) * k, y: middle.y - (held.middle.y - held.view.y) * k });
      return;
    }
    const dx = point.x - held.from.x;
    const dy = point.y - held.from.y;
    if (!pressRef.current.moved) {
      // A finger wobbles more than a mouse; a tap must not turn into a drag for it.
      if (Math.hypot(dx, dy) < (e.pointerType === 'mouse' ? 4 : 10)) return;
      pressRef.current.moved = true;
      held.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
    }
    if (held.view.zoom > 1.01) {
      place({ zoom: held.view.zoom, x: held.view.x + dx, y: held.view.y + dy });
    } else if (held.axis === 'y' && e.pointerType !== 'mouse') {
      // Shown whole, the picture has nowhere to go; pulled down, it is on its way out.
      pulledRef.current = Math.max(0, dy);
      place(viewRef.current);
    }
  };

  const onPointerUp = (e: React.PointerEvent, cancelled = false) => {
    if (!pointersRef.current.delete(e.pointerId)) return;
    // One finger of two was lifted: the other carries on from where the picture is now.
    if (pointersRef.current.size > 0) return grip();
    gripRef.current = null;
    if (pulledRef.current > 0) {
      const far = pulledRef.current > PULL_TO_CLOSE;
      pulledRef.current = 0;
      if (far && !cancelled) return onClose();
      return place(viewRef.current, true);
    }
    const press = pressRef.current;
    if (cancelled || press.moved || press.many || performance.now() - press.at > 400) return;
    // A tap. The second of two zooms in on the spot, or back out to the whole picture.
    const now = performance.now();
    const before = lastTapRef.current;
    if (before && now - before.at < 320 && Math.hypot(e.clientX - before.x, e.clientY - before.y) < 40) {
      lastTapRef.current = null;
      if (viewRef.current.zoom > 1.05) place({ zoom: 1, x: 0, y: 0 }, true);
      else zoomAt(DOUBLE_TAP_ZOOM, fromMiddle(e.clientX, e.clientY), true);
      return;
    }
    lastTapRef.current = { at: now, x: e.clientX, y: e.clientY };
  };

  /**
   * A tap beside the picture closes the viewer. On the click, not when the finger is lifted: the
   * click comes last, and one arriving after the viewer has gone would turn the page behind it.
   */
  const onClick = (e: React.MouseEvent) => {
    if (deaf() || pressRef.current.moved || pressRef.current.many) return;
    const box = state === 'shown' ? imgRef.current?.getBoundingClientRect() : undefined;
    if (!box || e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) onClose();
  };

  // ---- Buttons and keys ----
  /** Zooms around the middle of the screen. */
  const zoomBy = (factor: number) => zoomAt(viewRef.current.zoom * factor, { x: 0, y: 0 }, true);
  const whole = () => place({ zoom: 1, x: 0, y: 0 }, true);
  const guarded = (action: () => void) => () => {
    if (!deaf()) action();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Nothing typed here is meant for the book behind, where the arrows turn pages.
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const v = viewRef.current;
    const moves: Record<string, Point> = { ArrowLeft: { x: 80, y: 0 }, ArrowRight: { x: -80, y: 0 }, ArrowUp: { x: 0, y: 80 }, ArrowDown: { x: 0, y: -80 } };
    if (e.key === 'Escape') onClose();
    else if (e.key === '+' || e.key === '=') zoomBy(BUTTON_STEP);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / BUTTON_STEP);
    else if (e.key === '0') whole();
    else if (moves[e.key]) place({ zoom: v.zoom, x: v.x + moves[e.key].x, y: v.y + moves[e.key].y });
    else return;
    e.preventDefault();
  };

  return (
    <div ref={rootRef} className="image-viewer" role="dialog" aria-modal="true" aria-label="Перегляд зображення" tabIndex={-1} data-zoomed={percent > 100 || undefined} onKeyDown={onKeyDown}>
      <div
        ref={stageRef}
        className="image-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => onPointerUp(e)}
        onPointerCancel={(e) => onPointerUp(e, true)}
        onClick={onClick}
      >
        {state === 'failed' ? (
          <p className="image-viewer-note">Не вдалося показати зображення.</p>
        ) : (
          <img
            ref={imgRef}
            src={src}
            alt={alt ?? ''}
            draggable={false}
            style={{ background, visibility: state === 'shown' ? 'visible' : 'hidden' }}
            onLoad={() => {
              fit();
              setState('shown');
            }}
            onError={() => setState('failed')}
          />
        )}
      </div>
      <button className="image-viewer-close" onClick={guarded(onClose)} title="Закрити (Esc)" aria-label="Закрити">
        <X size={22} />
      </button>
      {state === 'shown' && (
        <div className="image-viewer-zoom" role="group" aria-label="Масштаб">
          <button onClick={guarded(() => zoomBy(1 / BUTTON_STEP))} disabled={percent <= 100} title="Зменшити" aria-label="Зменшити">
            <Minus size={20} />
          </button>
          <button className="image-viewer-percent" onClick={guarded(whole)} title="Показати цілою" aria-label={`Масштаб ${percent}%. Показати цілою`}>
            {percent}%
          </button>
          <button onClick={guarded(() => zoomBy(BUTTON_STEP))} disabled={percent >= MAX_ZOOM * 100} title="Збільшити" aria-label="Збільшити">
            <Plus size={20} />
          </button>
        </div>
      )}
    </div>
  );
}
