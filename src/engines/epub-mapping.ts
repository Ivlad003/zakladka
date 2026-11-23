// Finding the place of a page without reading the chapter up to it.
//
// After every page turn epub.js works out where the page starts and where it ends. It does so by
// walking the chapter's text from its first word and measuring each piece on the way — twice. The
// cost grows with the distance from the start of the chapter: in a book kept in one file (a whole
// book of 1 200 pages as one "chapter") that was 40 000 measurements and most of a second per turn
// near the end.
//
// Here the same place is found by going down the chapter's structure instead: among the blocks of
// the chapter, the first that reaches the page; inside it, the first of its parts that does; and so
// on down to a piece of text. What lies wholly before the page is passed over a block at a time,
// and a long row of blocks is halved rather than walked. A hundred or two measurements wherever the
// page is. Right-to-left books keep epub.js's own walk.
//
// The answer is the one epub.js gives, with one difference for the better: a line too long for the
// page (in a listing) sticks out into the next page, and epub.js takes it for the start of that
// page — a place on the page before. Such a line is not taken when the block it is in ends before
// the page.

interface Mapping {
  horizontal: boolean;
  direction: string;
  findStart(root: Node, start: number, end: number): Range;
  findEnd(root: Node, start: number, end: number): Range;
  findTextStartRange(node: Node, start: number, end: number): Range;
  findTextEndRange(node: Node, start: number, end: number): Range;
}

type Test = (rect: DOMRect) => boolean;

/** Something that is not displayed has no box at all. */
const noBox = (r: DOMRect) => r.width === 0 && r.height === 0 && r.left === 0 && r.top === 0;

/** How far back the look for an earlier match goes at most. */
const LOOK_BACK = 5000;

/**
 * The first of `count` things, in reading order, whose box passes the test; -1 when none does.
 *
 * Halving takes for granted that once one passes, those after it pass too. Things without a box
 * say nothing either way: the next one with a box decides. And where the order does not quite hold
 * (that long line again: it passes, the lines after it on its page do not), epub.js, walking from
 * the start, meets the earlier one first. So the things before the one found are looked at too, for
 * as long as they are `near` — on the page where such a stray could be.
 */
function firstWhere(count: number, boxOf: (i: number) => DOMRect, test: Test, near: Test): number {
  let lo = 0;
  let hi = count - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let i = mid;
    let box = boxOf(i);
    let passes = test(box);
    while (!passes && noBox(box) && i < hi) {
      box = boxOf(++i);
      passes = test(box);
    }
    if (passes) {
      best = i;
      hi = mid - 1;
    } else if (noBox(box)) hi = mid - 1;
    else lo = i + 1;
  }
  for (let i = best - 1, looked = 0; i >= 0 && looked < LOOK_BACK; i--, looked++) {
    const box = boxOf(i);
    if (test(box)) best = i;
    else if (!noBox(box) && !near(box)) break;
  }
  return best;
}

type Kid = Element | Text;
const isText = (node: Node): node is Text => node.nodeType === Node.TEXT_NODE;
/** What of an element's children can be or hold text: elements, and text that is not white space (as epub.js counts it). */
function kidsOf(parent: Node): Kid[] {
  const kids: Kid[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === Node.ELEMENT_NODE) kids.push(node as Element);
    else if (isText(node) && node.data.trim().length > 0) kids.push(node);
  }
  return kids;
}

/** Up to this many children are simply looked at one by one: the cells of a row, the parts of a sentence. */
const FEW = 32;

/**
 * The first piece of text under `parent`, in reading order, whose box passes the test and that lies
 * in blocks whose boxes pass it too. `probe` is a range to measure text with.
 */
function firstText(parent: Node, passes: Test, near: Test, probe: Range): Text | null {
  const kids = kidsOf(parent);
  const boxOf = (i: number) => {
    const kid = kids[i];
    if (!isText(kid)) return kid.getBoundingClientRect();
    probe.selectNodeContents(kid);
    return probe.getBoundingClientRect();
  };
  let from = 0;
  if (kids.length > FEW) {
    // Many children are blocks one after another (paragraphs, rows, lines of a listing): halved.
    from = firstWhere(kids.length, boxOf, passes, near);
    if (from < 0) return null;
    // An element without a box of its own may hold text that has one.
    while (from > 0 && !isText(kids[from - 1]) && noBox(boxOf(from - 1))) from--;
  }
  for (let i = from; i < kids.length; i++) {
    const kid = kids[i];
    const box = boxOf(i);
    if (isText(kid)) {
      if (passes(box)) return kid;
    } else if (passes(box) || noBox(box)) {
      // A block may reach the page while its text does not (a short cell beside a tall one): on to the next.
      const found = firstText(kid, passes, near, probe);
      if (found) return found;
    }
  }
  return null;
}

/** The last piece of text under `root` (not counting white space), or the one before `before`. */
function lastText(root: Node, before?: Text): Text | null {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  if (before) {
    walker.currentNode = before;
    node = walker.previousNode() as Text | null;
  } else node = walker.lastChild() as Text | null;
  while (node && node.data.trim().length === 0) node = walker.previousNode() as Text | null;
  return node;
}

/** Where epub.js cuts a piece of text into words — its own arithmetic, kept as it is so the places come out the same. */
function wordSpans(node: Text): [number, number][] | null {
  const text = node.data.trim();
  let pos = text.indexOf(' ');
  if (pos === -1) return null;
  const spans: [number, number][] = [[0, pos]];
  let from = -1;
  while (pos !== -1) {
    pos = text.indexOf(' ', pos + 1);
    if (pos > 0) {
      if (from >= 0) spans.push([from, pos]);
      from = pos + 1;
    }
  }
  if (from >= 0) spans.push([from, text.length]);
  return spans;
}

/** Longer pieces of text than this are searched by halving too; shorter ones are quick enough as they are. */
const LONG_TEXT = 2000;

const patched = new WeakSet<object>();

/** Teaches the page manager of a rendition (once it shows a chapter) to find places this way. */
export function speedUpMapping(rendition: unknown): void {
  const mapping = (rendition as { manager?: { mapping?: Mapping } } | null)?.manager?.mapping;
  const proto = mapping ? (Object.getPrototypeOf(mapping) as Mapping | null) : null;
  if (!proto || patched.has(proto) || typeof proto.findStart !== 'function' || typeof proto.findEnd !== 'function') return;
  patched.add(proto);
  const slow = { findStart: proto.findStart, findEnd: proto.findEnd, findTextStartRange: proto.findTextStartRange, findTextEndRange: proto.findTextEndRange };
  const rtl = (m: Mapping) => m.horizontal && m.direction === 'rtl';

  proto.findStart = function (this: Mapping, root, start, end) {
    const doc = root.ownerDocument;
    const last = doc && !rtl(this) ? lastText(root) : null;
    if (!doc || !last) return slow.findStart.call(this, root, start, end);
    const across = this.horizontal;
    const found = firstText(
      root,
      // Starts on this page, or began before it and runs into it.
      (r) => {
        const near = across ? r.left : r.top;
        return (near >= start && near <= end) || (across ? r.right : r.bottom) > start;
      },
      // A stray that reaches this page comes from the page before it.
      (r) => (across ? r.right : r.bottom) > start - (end - start),
      doc.createRange(),
    );
    return this.findTextStartRange(found ?? last, start, end);
  };

  proto.findEnd = function (this: Mapping, root, start, end) {
    const doc = root.ownerDocument;
    const last = doc && !rtl(this) ? lastText(root) : null;
    if (!doc || !last) return slow.findEnd.call(this, root, start, end);
    const across = this.horizontal;
    const near = (r: DOMRect) => Math.round(across ? r.left : r.top);
    const far = (r: DOMRect) => Math.round(across ? r.right : r.bottom);
    const probe = doc.createRange();
    // The first piece that reaches past the page: it holds the page's end, unless all of it lies
    // past the page — then the piece before it does.
    const found = firstText(
      root,
      (r) => near(r) > end || far(r) > end,
      // A stray that reaches past this page is on this page.
      (r) => far(r) > start,
      probe,
    );
    if (!found) return this.findTextEndRange(last, start, end);
    probe.selectNodeContents(found);
    const whole = near(probe.getBoundingClientRect()) > end;
    return this.findTextEndRange(whole ? (lastText(root, found) ?? root) : found, start, end);
  };

  // One piece of text can be long too: a listing of thousands of lines is a single piece.
  const spansOf = (m: Mapping, node: Node) => (!rtl(m) && isText(node) && node.data.length > LONG_TEXT ? wordSpans(node) : null);
  const wordRange = (node: Node, span: [number, number]) => {
    const range = node.ownerDocument!.createRange();
    range.setStart(node, span[0]);
    range.setEnd(node, span[1]);
    return range;
  };

  proto.findTextStartRange = function (this: Mapping, node, start, end) {
    const spans = spansOf(this, node);
    if (!spans) return slow.findTextStartRange.call(this, node, start, end);
    const across = this.horizontal;
    const probe = node.ownerDocument!.createRange();
    const at = firstWhere(
      spans.length,
      (i) => {
        probe.setStart(node, spans[i][0]);
        probe.setEnd(node, spans[i][1]);
        return probe.getBoundingClientRect();
      },
      (r) => (across ? r.left : r.top) >= start,
      (r) => (across ? r.right : r.bottom) > start - (end - start),
    );
    return wordRange(node, spans[Math.max(at, 0)]);
  };

  proto.findTextEndRange = function (this: Mapping, node, start, end) {
    const spans = spansOf(this, node);
    if (!spans) return slow.findTextEndRange.call(this, node, start, end);
    const across = this.horizontal;
    const probe = node.ownerDocument!.createRange();
    const boxOf = (i: number) => {
      probe.setStart(node, spans[i][0]);
      probe.setEnd(node, spans[i][1]);
      return probe.getBoundingClientRect();
    };
    const near = (r: DOMRect) => (across ? r.left : r.top);
    const far = (r: DOMRect) => (across ? r.right : r.bottom);
    const at = firstWhere(
      spans.length,
      boxOf,
      (r) => near(r) > end || far(r) > end,
      (r) => far(r) > start,
    );
    if (at < 0) return wordRange(node, spans[spans.length - 1]);
    return wordRange(node, spans[at > 0 && near(boxOf(at)) > end ? at - 1 : at]);
  };
}
