import type { Annotation, BookRecord, NormRect } from '../types';
import { downloadText } from './utils';

export function sortAnnotations(list: Annotation[]): Annotation[] {
  return [...list].sort((a, b) => a.unit - b.unit || a.createdAt - b.createdAt);
}

const TYPE_LABEL: Record<Annotation['type'], string> = {
  highlight: 'Виділення',
  note: 'Нотатка',
  bookmark: 'Закладка',
};

export function exportNotesMarkdown(book: BookRecord, annotations: Annotation[]): void {
  const lines = [`# ${book.title}`, book.author ? `*${book.author}*` : '', ''];
  for (const a of sortAnnotations(annotations)) {
    lines.push(`## ${TYPE_LABEL[a.type]} — ${a.label}${a.author === 'agent' ? ' (AI)' : ''}`);
    if (a.quote) lines.push(...a.quote.split('\n').map((l) => `> ${l}`), '');
    if (a.text) lines.push(a.text, '');
    if (a.sketch?.strokes.length) lines.push('_(є малюнок — доступний у застосунку)_', '');
    if (!a.quote && !a.text) lines.push('');
  }
  downloadText(`${book.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'notes'} — нотатки.md`, lines.join('\n'));
}

/** Merges overlapping/adjacent rectangles that sit on the same text line. */
export function mergeLineRects(rects: NormRect[]): NormRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: NormRect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const overlap = Math.min(last.y + last.h, r.y + r.h) - Math.max(last.y, r.y);
      const sameLine = overlap > Math.min(last.h, r.h) * 0.6;
      const gap = r.x - (last.x + last.w);
      if (sameLine && gap < Math.max(last.h, r.h) * 0.8) {
        const right = Math.max(last.x + last.w, r.x + r.w);
        const bottom = Math.max(last.y + last.h, r.y + r.h);
        last.x = Math.min(last.x, r.x);
        last.y = Math.min(last.y, r.y);
        last.w = right - last.x;
        last.h = bottom - last.y;
        continue;
      }
    }
    out.push({ ...r });
  }
  return out;
}

/** Client rects of only the text inside a range (element boxes would cover whole blocks). */
export function textRectsOfRange(range: Range): DOMRect[] {
  const rects: DOMRect[] = [];
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) {
    rects.push(...range.getClientRects());
    return rects;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!range.intersectsNode(node) || !node.data.trim()) continue;
    const part = document.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    rects.push(...part.getClientRects());
  }
  return rects.filter((r) => r.width > 0.5 && r.height > 0.5);
}
