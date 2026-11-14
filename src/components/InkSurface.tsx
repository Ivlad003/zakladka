import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { drawStroke, drawStrokes, strokeHit } from '../lib/ink';
import { cx, uid } from '../lib/utils';
import type { DrawState, Stroke } from '../types';

interface Props {
  strokes: Stroke[];
  /** `null` makes the surface a read-only overlay that lets pointer events through. */
  tool: DrawState | null;
  onChange?: (strokes: Stroke[], added?: Stroke) => void;
  className?: string;
}

const ERASER_RADIUS = 10;
const MAX_PIXELS = 12_000_000;

/** A canvas for freehand drawing. Strokes are stored normalized, so they survive any resize or zoom. */
export function InkSurface({ strokes, tool, onChange, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Local mirror so a finished stroke stays visible while the parent persists it.
  const [local, setLocal] = useState(strokes);
  const localRef = useRef(local);
  localRef.current = local;
  const liveRef = useRef<Stroke | null>(null);
  const erasingRef = useRef(false);
  const frameRef = useRef(0);

  useEffect(() => setLocal(strokes), [strokes]);

  const redraw = useCallback(() => {
    frameRef.current = 0;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    drawStrokes(ctx, localRef.current, canvas.width, canvas.height);
    if (liveRef.current) drawStroke(ctx, liveRef.current, canvas.width, canvas.height);
  }, []);

  const schedule = useCallback(() => {
    frameRef.current ||= requestAnimationFrame(redraw);
  }, [redraw]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current!;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      let w = Math.round(canvas.clientWidth * dpr);
      let h = Math.round(canvas.clientHeight * dpr);
      if (w * h > MAX_PIXELS) {
        const k = Math.sqrt(MAX_PIXELS / (w * h));
        w = Math.floor(w * k);
        h = Math.floor(h * k);
      }
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
      redraw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [redraw]);

  useEffect(redraw, [local, redraw]);

  const commit = (next: Stroke[], added?: Stroke) => {
    setLocal(next);
    localRef.current = next;
    onChange?.(next, added);
  };

  const eraseAt = (x: number, y: number, rect: DOMRect) => {
    const kept = localRef.current.filter((s) => !strokeHit(s, x, y, ERASER_RADIUS, rect.width, rect.height));
    if (kept.length !== localRef.current.length) commit(kept);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!tool || e.button !== 0) return;
    e.preventDefault();
    const canvas = e.currentTarget;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (tool.tool === 'eraser') {
      erasingRef.current = true;
      eraseAt(x, y, rect);
      return;
    }
    liveRef.current = { id: uid(), tool: tool.tool, color: tool.color, width: tool.size / rect.width, points: [x, y] };
    schedule();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!erasingRef.current && !liveRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const x = (ev.clientX - rect.left) / rect.width;
      const y = (ev.clientY - rect.top) / rect.height;
      if (erasingRef.current) {
        eraseAt(x, y, rect);
        continue;
      }
      const pts = liveRef.current!.points;
      const dx = (x - pts[pts.length - 2]) * rect.width;
      const dy = (y - pts[pts.length - 1]) * rect.height;
      if (dx * dx + dy * dy >= 0.5) pts.push(x, y);
    }
    schedule();
  };

  const finish = () => {
    erasingRef.current = false;
    const stroke = liveRef.current;
    if (!stroke) return;
    liveRef.current = null;
    commit([...localRef.current, stroke], stroke);
  };

  return (
    <canvas
      ref={canvasRef}
      className={cx('ink-surface', tool && 'ink-active', tool?.tool === 'eraser' && 'ink-eraser', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    />
  );
}
