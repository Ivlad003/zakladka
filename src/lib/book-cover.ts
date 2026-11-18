// The cover of a book the app wrote itself (lib/repo-book.ts), drawn on a canvas: there is no
// publisher to supply one. Three looks — a book, a magazine issue, the code as it is — each coloured
// from the repository's name, so that books about different repositories are told apart on a shelf.
import { canvasToBlob } from './utils';

export interface CoverText {
  kind: 'book' | 'magazine' | 'plain';
  title: string;
  subtitle: string;
  /** "owner/name". */
  repo: string;
  /** What of the repository the book is about: a branch, "PR #12", … */
  what: string;
  /** Small line above the title: "Книжка про код", "Журнал". */
  label: string;
  /** Magazine: the date line and the pieces of the issue. Plain: the top of the file tree. */
  dateLine?: string;
  listTitle?: string;
  list?: string[];
}

const W = 1000;
const H = 1500;
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';

function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A repeatable sequence of numbers in 0..1 for a given seed. */
function sequence(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10_000) / 10_000;
  };
}

/** Breaks text into lines no wider than `max`; a word longer than a line is cut. */
function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/)) {
    let rest = word;
    while (g.measureText(rest).width > max && rest.length > 1) {
      // A piece of the word that fits what is left of the line (or a whole line).
      let cut = rest.length;
      while (cut > 1 && g.measureText(`${line ? `${line} ` : ''}${rest.slice(0, cut)}`).width > max) cut--;
      if (cut <= 1 && line) {
        lines.push(line);
        line = '';
        continue;
      }
      lines.push(`${line ? `${line} ` : ''}${rest.slice(0, cut)}`);
      line = '';
      rest = rest.slice(cut);
    }
    const next = line ? `${line} ${rest}` : rest;
    if (g.measureText(next).width > max && line) {
      lines.push(line);
      line = rest;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Draws text in the largest of the sizes that fits `maxLines` lines; returns the y under it. */
function block(g: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, sizes: number[], maxLines: number, font: (size: number) => string, lead = 1.14): number {
  let size = sizes[sizes.length - 1];
  let lines: string[] = [];
  for (const s of sizes) {
    g.font = font(s);
    lines = wrap(g, text, max);
    size = s;
    if (lines.length <= maxLines) break;
  }
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[\s.,;:—–-]+$/, '')}…`;
  }
  g.textBaseline = 'top';
  lines.forEach((line, i) => g.fillText(line, x, y + i * size * lead));
  return y + lines.length * size * lead;
}

function spaced(g: CanvasRenderingContext2D, text: string, x: number, y: number, gap: number): void {
  let at = x;
  for (const ch of text) {
    g.fillText(ch, at, y);
    at += g.measureText(ch).width + gap;
  }
}

/** A history of commits with branches leaving the main line and coming back: the motif of every cover. */
function graph(g: CanvasRenderingContext2D, seed: number, x0: number, x1: number, y: number, lane: number, colors: string[], dot: string): void {
  const next = sequence(seed);
  const step = (x1 - x0) / 9;
  g.lineWidth = 7;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const points: [number, number, string][] = [];
  g.strokeStyle = colors[0];
  g.beginPath();
  g.moveTo(x0, y);
  g.lineTo(x1, y);
  g.stroke();
  for (let i = 0; i <= 9; i++) points.push([x0 + i * step, y, colors[0]]);
  let from = 1;
  for (let b = 1; b <= 2; b++) {
    const start = from + Math.floor(next() * 2);
    const length = 2 + Math.floor(next() * 2);
    const end = Math.min(8, start + length + 1);
    // The first branch runs below the main line, the second above it.
    const yb = y + (b === 1 ? lane : -lane);
    const color = colors[b % colors.length];
    g.strokeStyle = color;
    g.beginPath();
    g.moveTo(x0 + start * step, y);
    g.bezierCurveTo(x0 + (start + 0.5) * step, y, x0 + (start + 0.5) * step, yb, x0 + (start + 1) * step, yb);
    g.lineTo(x0 + (end - 1) * step, yb);
    g.bezierCurveTo(x0 + (end - 0.5) * step, yb, x0 + (end - 0.5) * step, y, x0 + end * step, y);
    g.stroke();
    for (let i = start + 1; i <= end - 1; i++) points.push([x0 + i * step, yb, color]);
    from = Math.min(5, end - 1);
  }
  for (const [px, py, color] of points) {
    g.beginPath();
    g.arc(px, py, 15, 0, Math.PI * 2);
    g.fillStyle = dot;
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = color;
    g.stroke();
  }
}

export async function drawCover(text: CoverText): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  const seed = hashOf(text.repo);
  const hue = seed % 360;
  const pad = 90;
  const inner = W - pad * 2;

  if (text.kind === 'magazine') {
    const accent = `hsl(${hue}, 62%, 40%)`;
    g.fillStyle = '#f5f0e6';
    g.fillRect(0, 0, W, H);
    g.fillStyle = accent;
    g.fillRect(0, 0, W, 300);
    // The masthead: the repository's name, as wide as the page allows.
    const name = (text.repo.split('/').pop() ?? text.repo).toUpperCase();
    let size = 170;
    do g.font = `900 ${size}px ${SANS}`;
    while (g.measureText(name).width > inner && (size -= 6) > 50);
    g.fillStyle = '#ffffff';
    g.textBaseline = 'alphabetic';
    g.fillText(name, pad, 215);
    g.font = `600 28px ${SANS}`;
    g.fillStyle = 'rgba(255,255,255,0.86)';
    spaced(g, text.label.toUpperCase(), pad, 268, 4);
    g.fillStyle = '#5b5750';
    g.font = `600 27px ${SANS}`;
    g.textBaseline = 'top';
    g.fillText([text.dateLine, text.what].filter(Boolean).join('  ·  '), pad, 335, inner);
    g.fillStyle = '#17171a';
    let y = block(g, text.title, pad, 420, inner, [104, 92, 80, 68, 58], 5, (s) => `800 ${s}px ${SANS}`, 1.08);
    g.fillStyle = '#4a4741';
    y = block(g, text.subtitle, pad, y + 26, inner, [40, 36], 3, (s) => `400 ${s}px ${SANS}`, 1.3);
    const list = (text.list ?? []).slice(0, 4);
    if (list.length && y < 1010) {
      let at = Math.max(y + 70, 1010);
      g.fillStyle = accent;
      g.font = `700 26px ${SANS}`;
      spaced(g, (text.listTitle ?? '').toUpperCase(), pad, at, 3);
      at += 52;
      list.forEach((item, i) => {
        if (at > H - 190) return;
        g.fillStyle = accent;
        g.font = `800 34px ${SANS}`;
        g.fillText(String(i + 1), pad, at);
        g.fillStyle = '#17171a';
        at = block(g, item, pad + 56, at, inner - 56, [32], 2, (s) => `500 ${s}px ${SANS}`, 1.25) + 16;
      });
    }
    graph(g, seed, pad + 20, W - pad - 20, H - 105, 46, [accent, `hsl(${(hue + 160) % 360}, 55%, 42%)`, `hsl(${(hue + 60) % 360}, 60%, 40%)`], '#f5f0e6');
  } else if (text.kind === 'plain') {
    g.fillStyle = '#0f1419';
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'top';
    g.fillStyle = `hsl(${hue}, 70%, 68%)`;
    g.font = `600 30px ${MONO}`;
    g.fillText(`$ git show ${text.what}`.slice(0, 44), pad, 120, inner);
    g.fillStyle = '#e6edf3';
    let y = block(g, text.title, pad, 230, inner, [84, 72, 62, 52], 5, (s) => `700 ${s}px ${MONO}`, 1.15);
    g.fillStyle = '#9aa7b4';
    y = block(g, text.subtitle, pad, y + 30, inner, [32], 3, (s) => `400 ${s}px ${SANS}`, 1.35);
    g.font = `400 31px ${MONO}`;
    const list = (text.list ?? []).slice(0, 9);
    let at = Math.max(y + 80, 820);
    list.forEach((item, i) => {
      if (at > H - 200) return;
      g.fillStyle = '#5c6975';
      g.fillText(i === list.length - 1 ? '└──' : '├──', pad, at);
      g.fillStyle = '#c3ccd5';
      g.fillText(item, pad + 90, at, inner - 90);
      at += 52;
    });
    g.fillStyle = `hsl(${hue}, 70%, 68%)`;
    g.font = `600 30px ${MONO}`;
    g.fillText(text.repo, pad, H - 130, inner);
  } else {
    const bg = g.createLinearGradient(0, 0, W * 0.4, H);
    bg.addColorStop(0, `hsl(${hue}, 44%, 22%)`);
    bg.addColorStop(1, `hsl(${(hue + 28) % 360}, 50%, 11%)`);
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.72)';
    g.font = `600 28px ${SANS}`;
    g.textBaseline = 'top';
    spaced(g, text.label.toUpperCase(), pad, 110, 5);
    graph(g, seed, pad + 20, W - pad - 20, 400, 120, ['rgba(255,255,255,0.9)', `hsl(${(hue + 150) % 360}, 75%, 68%)`, `hsl(${(hue + 55) % 360}, 80%, 66%)`], `hsl(${hue}, 44%, 17%)`);
    g.fillStyle = '#ffffff';
    let y = block(g, text.title, pad, 660, inner, [98, 86, 74, 64, 56], 5, (s) => `800 ${s}px ${SANS}`, 1.1);
    g.fillStyle = 'rgba(255,255,255,0.8)';
    y = block(g, text.subtitle, pad, y + 30, inner, [38, 34], 3, (s) => `400 ${s}px ${SANS}`, 1.3);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(pad, H - 200, inner, 2);
    g.fillStyle = '#ffffff';
    g.font = `600 34px ${MONO}`;
    g.fillText(text.repo, pad, H - 170, inner);
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.font = `400 28px ${SANS}`;
    g.fillText(text.what, pad, H - 118, inner);
  }
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
  return new Uint8Array(await blob.arrayBuffer());
}
