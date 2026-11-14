import type { PageSize } from './types';

/** A piece of page text with its box, in page-relative coordinates (0..1, origin at the top-left). */
export interface TextZone {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Scanned books are mostly set in serif type; matching it keeps words close to their place within a line. */
const SERIF = '"Times New Roman", Times, serif';
let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * Fills a text layer with one invisible span per zone (DjVu text zones, OCR words).
 * Each span is stretched horizontally to exactly cover its box. The caller sets the CSS variable
 * `--scale-factor` to the current zoom; `base` is the page size at 100%.
 */
export function buildZoneLayer(container: HTMLElement, zones: TextZone[], base: PageSize): void {
  container.style.fontFamily = SERIF;
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const frag = document.createDocumentFragment();
  for (const zone of zones) {
    const text = zone.text.replace(/\s+/g, ' ').trim();
    if (!text || zone.w <= 0 || zone.h <= 0) continue;
    const fontPx = zone.h * base.height * 0.85;
    let stretch = 1;
    if (measureCtx) {
      measureCtx.font = `${fontPx}px ${SERIF}`;
      const measured = measureCtx.measureText(text).width;
      if (measured > 0) stretch = (zone.w * base.width) / measured;
    }
    const span = document.createElement('span');
    // The trailing space keeps words apart when the selection is copied.
    span.textContent = `${text} `;
    span.style.cssText =
      `left:${(zone.x * 100).toFixed(3)}%;top:${(zone.y * 100).toFixed(3)}%;` +
      `font-size:calc(var(--scale-factor) * ${fontPx.toFixed(2)}px);transform:scaleX(${stretch.toFixed(4)});`;
    frag.append(span);
  }
  container.append(frag);
}

/** Joins zones into plain text, starting a new line whenever the next zone sits clearly lower. */
export function zonesToText(zones: TextZone[]): string {
  let out = '';
  let prev: TextZone | null = null;
  for (const zone of zones) {
    const text = zone.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (prev) out += zone.y > prev.y + prev.h * 0.6 ? '\n' : ' ';
    out += text;
    prev = zone;
  }
  return out;
}
