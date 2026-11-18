// Diagrams in the agents' answers and in the books the app writes. A model writes a diagram as text
// (Mermaid, in a ```mermaid block) and it is drawn here. The library is large, so it is loaded when
// the first diagram appears.
import { canvasToBlob } from './utils';

type Mermaid = typeof import('mermaid').default;

let library: Promise<Mermaid> | null = null;
let counter = 0;

async function draw(code: string, config: Parameters<Mermaid['initialize']>[0]): Promise<string> {
  library ??= import('mermaid').then((m) => m.default);
  const mermaid = await library;
  // "strict": labels are plain text and the diagram cannot carry links or scripts.
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', ...config });
  const id = `zk-diagram-${++counter}`;
  try {
    return (await mermaid.render(id, code)).svg;
  } finally {
    // On a syntax error Mermaid leaves its own error picture in the page.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/** Draws a Mermaid diagram and returns it as SVG markup; throws when the text is not a valid diagram. */
export function renderDiagram(code: string, dark: boolean): Promise<string> {
  return draw(code, { theme: dark ? 'dark' : 'neutral', fontFamily: 'inherit' });
}

export interface DiagramPicture {
  data: Uint8Array;
  type: 'image/png' | 'image/svg+xml';
  /** Size the diagram was drawn for, in CSS pixels; the PNG itself is larger, to stay sharp. */
  width: number;
  height: number;
}

/**
 * A diagram as a picture for a book: drawn once, dark on white, so that it looks the same in every
 * theme, in other reading apps and in a PDF. A page of a book cannot run the script that draws it.
 * Throws when the text is not a valid diagram.
 */
export async function diagramPicture(code: string): Promise<DiagramPicture> {
  // Labels as SVG text, not as HTML inside the SVG: a browser will not paint the latter onto a canvas
  // (Safari) or lets it taint the canvas, and other reading apps do not show it at all. The font has
  // to be one the picture can name by itself — "inherit" means nothing outside the page.
  const svg = await draw(code, { theme: 'neutral', htmlLabels: false, fontFamily: 'Arial, Helvetica, sans-serif' });
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg') throw new Error('Діаграму не вдалося намалювати.');
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const width = Math.max(40, box[2] || parseFloat(root.getAttribute('width') ?? '') || 600);
  const height = Math.max(30, box[3] || parseFloat(root.getAttribute('height') ?? '') || 400);
  // Mermaid sizes its pictures in percent of the page; a picture on its own needs real numbers.
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  root.removeAttribute('style');
  const markup = new XMLSerializer().serializeToString(root);
  const asSvg = (): DiagramPicture => ({ data: new TextEncoder().encode(markup), type: 'image/svg+xml', width, height });
  try {
    const image = new Image();
    image.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('svg'));
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    });
    const scale = Math.max(0.5, Math.min(2, 2400 / width, 3200 / height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, 'image/png');
    return { data: new Uint8Array(await blob.arrayBuffer()), type: 'image/png', width, height };
  } catch {
    // The browser would not turn it into a bitmap: the drawing itself still goes into the book.
    return asSvg();
  }
}
