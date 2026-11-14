// Which words of a laid-out document are on screen. Used for reading aloud: epub.js reports where
// a page starts and ends only roughly, and words lost or repeated at every page turn are audible.
//
// The window is given in the document's own coordinates. In a paginated chapter the text runs in
// columns, so a word is on the page when it starts between the left and right edge of the column;
// consecutive pages share an edge, so nothing falls between them and nothing is taken twice.

export type TextWindow =
  /** A page of a paginated chapter: words starting at `from` ≤ x < `to`. */
  | { axis: 'x'; from: number; to: number }
  /** A scrolled chapter: everything from the first line that reaches below `from` to the end. */
  | { axis: 'y'; from: number };

const WORD = /\S+/g;

function blockOf(node: Node): Element | null {
  let el = node.parentElement;
  while (el && el.ownerDocument.defaultView?.getComputedStyle(el).display.startsWith('inline')) el = el.parentElement;
  return el;
}

/** The text of `doc` that lies in the window, in reading order. */
export function textInWindow(doc: Document, win: TextWindow): string {
  if (!doc.body) return '';
  const range = doc.createRange();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  // Half a pixel of slack: column edges are whole numbers, glyph boxes are not always.
  const inside = (rect: DOMRect) => (win.axis === 'x' ? rect.left >= win.from - 0.5 && rect.left < win.to - 0.5 : rect.bottom > win.from + 0.5);
  let out = '';
  let lastBlock: Element | null = null;
  const add = (node: Text, text: string) => {
    if (!text) return;
    const block = blockOf(node);
    // Paragraphs often follow each other with no white space between them in the markup.
    if (out && block !== lastBlock && !/\s$/.test(out) && !/^\s/.test(text)) out += ' ';
    lastBlock = block;
    out += text;
  };
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const data = node.data;
    if (!data.trim()) {
      // White space between elements still separates words.
      if (out && !/\s$/.test(out)) out += ' ';
      continue;
    }
    range.selectNodeContents(node);
    const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
    if (!lines.length) continue; // not displayed
    const hits = lines.filter(inside).length;
    if (hits === 0) continue;
    if (hits === lines.length) {
      add(node, data);
      continue;
    }
    // The node straddles an edge of the window: take it word by word.
    let from = -1;
    let to = -1;
    WORD.lastIndex = 0;
    for (let m = WORD.exec(data); m; m = WORD.exec(data)) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const first = range.getClientRects()[0];
      if (!first || !inside(first)) {
        if (from >= 0 && win.axis === 'x') break; // past the right edge
        continue;
      }
      if (from < 0) from = m.index;
      to = m.index + m[0].length;
    }
    if (from >= 0) add(node, `${data.slice(from, to)} `);
  }
  return out;
}
