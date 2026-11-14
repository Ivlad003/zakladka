import type { SearchHit } from '../types';
import { makeExcerpt, queryRegex } from '../lib/utils';
import type { SearchOptions } from './types';

/** Full-text search over units (pages) whose text is available as plain strings. */
export async function searchUnits(
  count: number,
  getText: (unit: number) => Promise<string>,
  label: (unit: number) => string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const re = queryRegex(query);
  if (!re) return [];
  const limit = opts.limit ?? 500;
  const hits: SearchHit[] = [];

  for (let unit = 0; unit < count && hits.length < limit; unit++) {
    if (opts.signal?.aborted) break;
    const text = await getText(unit);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let matchIndex = 0;
    while ((m = re.exec(text)) && hits.length < limit) {
      hits.push({ unit, label: label(unit), matchIndex: matchIndex++, ...makeExcerpt(text, m.index, m[0].length) });
      if (m[0].length === 0) re.lastIndex++;
    }
    opts.onProgress?.(unit + 1, count);
  }
  return hits;
}

/**
 * Finds query matches inside a rendered text layer and returns DOM ranges for them,
 * in document order. `<br>` elements count as whitespace so matches can span lines.
 */
export function findRangesInLayer(layer: HTMLElement, query: string): Range[] {
  const re = queryRegex(query);
  if (!re) return [];

  const nodes: { node: Text; start: number }[] = [];
  let text = '';
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      nodes.push({ node: n as Text, start: text.length });
      text += (n as Text).data;
    } else if ((n as Element).tagName === 'BR') {
      text += ' ';
    }
  }
  if (!nodes.length) return [];

  const locate = (pos: number, isEnd: boolean): [Text, number] => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (nodes[mid].start <= pos) lo = mid;
      else hi = mid - 1;
    }
    // An end offset that lands exactly on a node boundary belongs to the previous node.
    if (isEnd && lo > 0 && nodes[lo].start === pos) lo--;
    const { node, start } = nodes[lo];
    return [node, Math.min(node.data.length, Math.max(0, pos - start))];
  };

  const ranges: Range[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const range = document.createRange();
    range.setStart(...locate(m.index, false));
    range.setEnd(...locate(m.index + m[0].length, true));
    ranges.push(range);
  }
  return ranges;
}
