// What both the text mode and the automatic table of contents need to know about the lines of
// PDF/DjVu pages: which size the body text is set in, and which lines are running heads and page
// numbers rather than text.
import type { PageLayout, PageLine } from './types';

export const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** A line with its digits blurred, so that "34 Chapter 1" and "36 Chapter 1" count as the same running head. */
export const normalizeEdge = (text: string) => text.toLocaleLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

export const isPageNumber = (text: string) => /^([-–—\s]*\d{1,4}[-–—\s]*|(стор|с|page|p)\.?\s*\d{1,4}|[ivxlcdm]{1,6})$/i.test(text.trim());

/** Lines in the top and bottom bands of a page, where running heads and page numbers sit. */
export function edgeLines(layout: PageLayout): PageLine[] {
  const band = layout.height * 0.08;
  return layout.lines.filter((l) => l.text.length < 120 && (l.y < band + l.size || l.y > layout.height - band));
}

/** The size most of the book's characters are set in. */
export function bodySizeOf(layouts: PageLayout[]): number {
  const weighted = new Map<number, number>();
  for (const layout of layouts) {
    for (const l of layout.lines) {
      const size = Math.round(l.size * 2) / 2;
      weighted.set(size, (weighted.get(size) ?? 0) + l.text.length);
    }
  }
  return [...weighted].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
}

/** Tells running heads from text: an edge line that recurs on a good share of the pages. */
export function runningHeads(layouts: PageLayout[]): (line: PageLine, layout: PageLayout) => boolean {
  const counts = new Map<string, number>();
  for (const layout of layouts) {
    for (const key of new Set(edgeLines(layout).map((l) => normalizeEdge(l.text)))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = (key: string) => layouts.length >= 4 && (counts.get(key) ?? 0) >= Math.max(3, layouts.length * 0.3);
  return (line, layout) => edgeLines(layout).includes(line) && (isPageNumber(line.text) || repeated(normalizeEdge(line.text)));
}
