import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { noteGesture, type TapZone } from '../lib/gestures';

interface Props {
  /** The finger has moved `dx` pixels sideways: the page follows. */
  onDrag(dx: number): void;
  /** The finger was lifted after `ms`: turn the page or let it spring back. */
  onRelease(dx: number, ms: number): void;
  onTap(zone: TapZone): void;
  /** Where the reader is, shown in the bar. */
  label: string;
  /** A second, quieter line: the time left. */
  hint?: string;
  /** 0..1, drawn as a line along the top of the bar. */
  progress: number;
}

/**
 * Takes sideways swipes and taps on an element. The listeners are not passive and cancel the
 * touch's default action, which is what keeps Safari from treating a swipe near the screen edge as
 * "go back", and the page from scrolling.
 */
function useZone(ref: React.RefObject<HTMLElement | null>, handlers: React.RefObject<Pick<Props, 'onDrag' | 'onRelease'> & { tap(x: number): void }>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start: { x: number; y: number; t: number; moved: boolean } | null = null;
    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length !== 1) return void (start = null);
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, t: performance.now(), moved: false };
      noteGesture('start');
    };
    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      if (!start || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - start.x;
      if (!start.moved && Math.abs(dx) < 6) return;
      start.moved = true;
      noteGesture('move', `зона свайпу: dx ${Math.round(dx)}`);
      handlers.current.onDrag(dx);
    };
    const onEnd = (e: TouchEvent) => {
      e.preventDefault();
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const ms = performance.now() - start.t;
      const moved = start.moved;
      start = null;
      noteGesture('end', `зона свайпу: dx ${Math.round(dx)}, ${Math.round(ms)} мс`);
      if (moved) handlers.current.onRelease(dx, ms);
      else if (ms < 600) handlers.current.tap(t.clientX);
    };
    const onCancel = () => {
      if (start?.moved) handlers.current.onRelease(0, 1000);
      start = null;
      noteGesture('cancel');
    };
    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onCancel);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [ref, handlers]);
}

/**
 * Places made for swiping: a bar under the page and a narrow strip along each side of the screen.
 * They belong to the app itself rather than to the page of the book, so touches on them always
 * arrive — also in browsers that keep gestures on the book's page to themselves. The bar doubles
 * as a status line: where the reader is in the book.
 */
export function SwipeZones({ onDrag, onRelease, onTap, label, hint, progress }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  // In the bar a tap acts by where it lands; a tap on a side strip turns that way.
  const bar = useRef({ onDrag, onRelease, tap: (_x: number) => {} });
  bar.current = {
    onDrag,
    onRelease,
    tap: (x) => {
      const box = barRef.current!.getBoundingClientRect();
      const at = (x - box.left) / box.width;
      onTap(at < 1 / 3 ? 'left' : at > 2 / 3 ? 'right' : 'center');
    },
  };
  const left = useRef({ onDrag, onRelease, tap: (_x: number) => {} });
  left.current = { onDrag, onRelease, tap: () => onTap('left') };
  const right = useRef({ onDrag, onRelease, tap: (_x: number) => {} });
  right.current = { onDrag, onRelease, tap: () => onTap('right') };

  useZone(barRef, bar);
  useZone(leftRef, left);
  useZone(rightRef, right);

  return (
    <>
      <div ref={leftRef} className="swipe-edge left" aria-hidden />
      <div ref={rightRef} className="swipe-edge right" aria-hidden />
      <div ref={barRef} className="swipe-bar" role="group" aria-label="Смуга для гортання свайпом">
        <div className="swipe-bar-progress">
          <div style={{ width: `${Math.round(progress * 1000) / 10}%` }} />
        </div>
        <ChevronLeft size={18} />
        <span className={hint ? 'swipe-bar-label two-lines' : 'swipe-bar-label'}>
          <span>{label}</span>
          {hint && <small>{hint}</small>}
        </span>
        <ChevronRight size={18} />
      </div>
    </>
  );
}
