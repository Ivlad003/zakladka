import type { Stroke } from '../types';

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, w: number, h: number): void {
  const p = stroke.points;
  if (p.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.globalAlpha = stroke.tool === 'marker' ? 0.35 : 1;
  const lineWidth = Math.max(0.75, stroke.width * w);
  ctx.lineWidth = lineWidth;

  if (p.length === 2) {
    ctx.beginPath();
    ctx.arc(p[0] * w, p[1] * h, lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Quadratic curves through segment midpoints give a smooth line from raw pointer samples.
  ctx.beginPath();
  ctx.moveTo(p[0] * w, p[1] * h);
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = ((p[i] + p[i + 2]) / 2) * w;
    const my = ((p[i + 1] + p[i + 3]) / 2) * h;
    ctx.quadraticCurveTo(p[i] * w, p[i + 1] * h, mx, my);
  }
  ctx.lineTo(p[p.length - 2] * w, p[p.length - 1] * h);
  ctx.stroke();
  ctx.restore();
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  for (const stroke of strokes) drawStroke(ctx, stroke, w, h);
}

/** True if the point (normalized) is within `radiusPx` of the stroke on a surface of w×h CSS pixels. */
export function strokeHit(stroke: Stroke, x: number, y: number, radiusPx: number, w: number, h: number): boolean {
  const p = stroke.points;
  const px = x * w;
  const py = y * h;
  const r = radiusPx + (stroke.width * w) / 2;
  const r2 = r * r;
  for (let i = 0; i < p.length; i += 2) {
    const ax = p[i] * w;
    const ay = p[i + 1] * h;
    const hasNext = i + 3 < p.length;
    const bx = hasNext ? p[i + 2] * w : ax;
    const by = hasNext ? p[i + 3] * h : ay;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const cx = ax + t * dx - px;
    const cy = ay + t * dy - py;
    if (cx * cx + cy * cy <= r2) return true;
  }
  return false;
}
