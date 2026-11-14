import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Contents, Location, Rendition } from 'epubjs';
import type { EpubEngineLike } from '../engines/types';
import { attachTouch, isTap, isTouchDevice, newTapState, noteGesture, reducedMotion, wasTap, zoneOf, type TapZone, type TouchHandlers } from '../lib/gestures';
import { debounce, isTypingTarget } from '../lib/utils';
import { textInWindow } from '../lib/visible-text';
import { HIGHLIGHT_COLORS, READING_PALETTE, type EpubFlow, type EpubFont, type Theme } from '../settings';
import type { Annotation, SearchHit, SelectionInfo } from '../types';

export interface EpubPosition {
  cfi: string;
  endCfi: string;
  unit: number;
  /** Whole-book progress 0..1 (approximate until the location index is ready). */
  percent: number;
  chapterPage: number;
  chapterPages: number;
  /**
   * The view was laid out again (opened, resized, restyled) and came back to the reading place: not
   * a move of the reader's, so it is not saved. The page shown may start a little earlier than the
   * place itself, and saving that would creep backwards with every change of screen size.
   */
  layout: boolean;
}

export interface EpubViewApi {
  next(): void;
  prev(): void;
  /** `fallbackUnit` is used when the target cannot be resolved (stale CFI, unusual href). */
  goToCfi(cfi: string, fallbackUnit?: number): void;
  goToHref(href: string, fallbackUnit?: number): void;
  goToUnit(unit: number): void;
  goToPercent(p: number): void;
  clearSelection(): void;
  /** A swipe made outside the page (on the swipe bar): the page follows the finger by `dx` pixels… */
  drag(dx: number): void;
  /** …and when the finger is lifted after `ms`, it turns or springs back. */
  release(dx: number, ms: number): void;
  /** For reading aloud: the text of the page on screen (once a page turn under way has finished)… */
  visibleText(): Promise<string>;
  /** …what identifies that page… */
  pageKey(): string;
  /** …and a page turn that resolves once the next page is shown (false at the end of the book). */
  nextPage(): Promise<boolean>;
}

type Anchor = SelectionInfo['anchor'];

interface Props {
  engine: EpubEngineLike;
  initialCfi: string | null;
  theme: Theme;
  fontSize: number;
  font: EpubFont;
  lineHeight: number;
  flow: EpubFlow;
  /** Whether a horizontal swipe turns the page. */
  swipe: boolean;
  /** Whether a sideways swipe with two fingers turns the page. */
  swipe2: boolean;
  /** Typography beyond the font and its size. */
  typography: Typography;
  /** Object URL of the reader's own font, when they chose it. */
  customFontUrl?: string;
  /** Two pages side by side. */
  spread: boolean;
  /** A link to a footnote was followed: its text, for a popup instead of a jump. */
  onFootnote?(note: { text: string; href: string }): void;
  annotations: Annotation[];
  activeHit: SearchHit | null;
  onRelocated(pos: EpubPosition): void;
  onSelection(sel: SelectionInfo | null): void;
  onAnnotationClick(annotation: Annotation, anchor: Anchor): void;
  onKey(e: KeyboardEvent): void;
  /** A finger tapped the page (not a link or a highlight). */
  onTap?(zone: TapZone): void;
  /** The reader started moving through the book by touch: time to get the bars out of the way. */
  onReadingGesture?(): void;
  /** Two fingers moved apart (1) or together (-1) far enough for one step of the font size. */
  onPinch?(dir: 1 | -1): void;
}

/** The parts of epub.js's page manager that turning pages by hand relies on. */
interface PageManager {
  container: HTMLElement;
  layout: { delta: number };
  settings: { direction?: string };
  scrollBy(x: number, y: number, silent: boolean): void;
}

const EASE = 'cubic-bezier(0.22, 0.8, 0.24, 1)';
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export interface Typography {
  align: 'publisher' | 'left' | 'justify';
  hyphens: boolean;
  letterSpacing: number;
  paragraphGap: 'publisher' | 'none' | 'small' | 'large';
}

const FONT_STACKS: Record<EpubFont, string | null> = {
  custom: '"ZkReaderFont", Georgia, serif',
  publisher: null,
  serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
};

const STYLE_ID = 'zk-reader-style';

const EPUB_NS = 'http://www.idpf.org/2007/ops';

/** Whether a link points to a footnote: marked as one, or looks like one (a small number or mark, often raised). */
function isNoteRef(link: Element): boolean {
  const type = `${link.getAttributeNS(EPUB_NS, 'type') ?? ''} ${link.getAttribute('epub:type') ?? ''} ${link.getAttribute('role') ?? ''}`;
  if (/noteref|doc-noteref|footnote|endnote/i.test(type)) return true;
  if (/(^|\s)(note|footnote|endnote|fn|noteref)/i.test(link.getAttribute('class') ?? '')) return true;
  const text = (link.textContent ?? '').trim();
  const raised = Boolean(link.closest('sup')) || Boolean(link.querySelector('sup'));
  return /^[\[(]?\s*(\d{1,3}|[*†‡§¶]+|[a-z])\s*[\])]?$/i.test(text) && (raised || text.length <= 4);
}

/** A link's target as a path inside the book, relative to the package. */
function resolveHref(sectionHref: string, href: string): string {
  try {
    const url = new URL(href, `http://book/${sectionHref}`);
    return `${decodeURIComponent(url.pathname.slice(1))}${url.hash}`;
  } catch {
    return href;
  }
}

/**
 * The text of the note a link points to; null when the target cannot be found (the link is then
 * followed as usual). A target that is an empty anchor stands for the paragraph it sits in.
 */
async function noteText(engine: EpubEngineLike, doc: Document, sectionHref: string, href: string): Promise<{ text: string; href: string } | null> {
  const full = resolveHref(sectionHref, href);
  const [file, id] = full.split('#');
  if (!id) return null;
  let target: Element | null = null;
  try {
    if (!file || file === sectionHref || href.startsWith('#')) target = doc.getElementById(id);
    else {
      const section = engine.book.spine.get(file) as unknown as { load(loader: unknown): Promise<Element> } | undefined;
      const root = section ? await section.load(engine.book.load.bind(engine.book)) : null;
      target = root?.querySelector(`[id="${CSS.escape(id)}"]`) ?? null;
    }
  } catch {
    return null;
  }
  if (!target) return null;
  let box: Element = target;
  // An anchor, a heading or a lone number is only the start of the note: take the block around or after it.
  while ((box.textContent ?? '').trim().length < 12 && box.parentElement && !/^(body|section)$/i.test(box.parentElement.localName)) box = box.parentElement;
  if ((box.textContent ?? '').trim().length < 12 && box.nextElementSibling) box = box.nextElementSibling;
  const text = (box.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text ? { text: text.length > 1500 ? `${text.slice(0, 1500)}…` : text, href: full } : null;
}
/**
 * The same stretch of a page with both ends inside text nodes: the start at the first letter at or
 * after it, the end after the last letter before it. Null when there is no text in between.
 */
function intoText(range: Range): Range | null {
  const doc = range.startContainer.ownerDocument;
  if (!doc?.body) return null;
  const texts: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.trim()) texts.push(n as Text);
  const start = range.cloneRange();
  start.collapse(true);
  const end = range.cloneRange();
  end.collapse(false);
  const out = doc.createRange();
  if (range.startContainer.nodeType === Node.TEXT_NODE) out.setStart(range.startContainer, range.startOffset);
  else {
    // comparePoint: 0 at the start itself, 1 after it.
    const first = texts.find((t) => start.comparePoint(t, 0) >= 0);
    if (!first) return null;
    out.setStart(first, 0);
  }
  if (range.endContainer.nodeType === Node.TEXT_NODE) out.setEnd(range.endContainer, range.endOffset);
  else {
    const last = [...texts].reverse().find((t) => end.comparePoint(t, t.length) <= 0);
    if (!last) return null;
    out.setEnd(last, last.length);
  }
  return out.collapsed ? null : out;
}

/**
 * Prefix that outweighs any selector a book is likely to use: an id inside :not() counts as an id.
 * The reader's choice of font must win even over a book's own `!important` rules on classes.
 */
const STRONG = 'html:not(#zk-none)';

function contentCss(p: Pick<Props, 'theme' | 'fontSize' | 'font' | 'lineHeight' | 'flow' | 'typography' | 'customFontUrl'>): string {
  const colors = READING_PALETTE[p.theme];
  const font = p.font === 'custom' && !p.customFontUrl ? null : FONT_STACKS[p.font];
  const t = p.typography;
  const gap = { publisher: null, none: '0', small: '0.5em', large: '1em' }[t.paragraphGap];
  return `
    ${p.font === 'custom' && p.customFontUrl ? `@font-face { font-family: "ZkReaderFont"; src: url("${p.customFontUrl}"); font-display: swap; }` : ''}
    ${t.align !== 'publisher' ? `${STRONG} body :is(p, li, blockquote, dd, div) { text-align: ${t.align === 'justify' ? 'justify' : 'start'} !important; }` : ''}
    ${t.hyphens ? `${STRONG} body, ${STRONG} body * { hyphens: auto !important; -webkit-hyphens: auto !important; }` : ''}
    ${t.letterSpacing ? `${STRONG} body { letter-spacing: ${t.letterSpacing}em !important; word-spacing: ${t.letterSpacing * 2}em !important; }` : ''}
    ${gap !== null ? `${STRONG} body p { margin-top: 0 !important; margin-bottom: ${gap} !important; }` : ''}
    /* The frame must share the app's colour scheme, or the browser paints an opaque white canvas behind it. */
    :root { color-scheme: ${p.theme === 'dark' ? 'dark' : 'light'}; }
    /* Pages are turned by the reader itself; the browser must not pan, zoom or flash a tap highlight here. */
    html { touch-action: ${p.flow === 'paginated' ? 'none' : 'pan-y'}; -webkit-tap-highlight-color: transparent; overscroll-behavior: none; }
    html, body { background: transparent !important; }
    body {
      color: ${colors.fg} !important;
      font-size: ${p.fontSize}% !important;
      line-height: ${p.lineHeight} !important;
      -webkit-text-size-adjust: none; text-size-adjust: none;
    }
    p, li, blockquote, dd, dt { line-height: inherit !important; }
    ${font ? `${STRONG} body { font-family: ${font} !important; }
    ${STRONG} body *:not(pre):not(code):not(kbd):not(samp):not(tt):not(pre *):not(code *) { font-family: inherit !important; }` : ''}
    ${p.theme === 'light' ? '' : 'body * { color: inherit !important; background-color: transparent !important; }'}
    a, a * { color: ${colors.link} !important; }
    ::selection { background: rgba(80, 140, 255, 0.35); }
  `;
}

/** Reflowable EPUB view built on epub.js. */
export const EpubView = forwardRef<EpubViewApi, Props>(function EpubView(props, ref) {
  const { engine, flow, theme, fontSize, font, lineHeight, annotations, activeHit } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const currentCfiRef = useRef<string | null>(props.initialCfi);
  /** The reading place: where the book was opened, or where the reader last moved to themselves. */
  const anchorRef = useRef<string | null>(props.initialCfi);
  /** Layouts in progress (open, resize, restyle); relocations while there are any are not the reader's moves. */
  const layoutRef = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;
  const appliedRef = useRef(new Map<string, string>());
  const searchMarkRef = useRef<string | null>(null);
  const turnRef = useRef<(dir: 1 | -1) => void>(() => {});
  const turningRef = useRef<() => boolean>(() => false);
  const dragRef = useRef<{ drag(dx: number): void; release(dx: number, ms: number): void }>({ drag: () => {}, release: () => {} });
  /** When a highlight was last tapped: that tap must not also turn the page or toggle the bars. */
  const markClickedRef = useRef(0);
  /** When a finger tap was last acted on; the click a browser may send after it is then ignored. */
  const tapTakenRef = useRef(0);

  /**
   * Shows a place. `layout`: the view is only being laid out again at the reading place (not a move
   * of the reader's); relocations until a moment after it has settled are reported as layout.
   */
  const display = (target?: string, fallbackUnit?: number, layout = false) => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    // The reader going somewhere ends any layout still settling: that move is theirs.
    if (layout) layoutRef.current++;
    else layoutRef.current = 0;
    const done = () => {
      if (layout) setTimeout(() => (layoutRef.current = Math.max(0, layoutRef.current - 1)), 400);
    };
    rendition.display(target).then(done, () => {
      // A stale or malformed target must not leave the view blank.
      if (!target) return done();
      const section = fallbackUnit !== undefined ? engine.book.spine.get(fallbackUnit) : null;
      void rendition
        .display(section?.href)
        .catch(() => {})
        .finally(done);
    });
  };
  /** The view laid out again: back to the reading place, without counting it as a move. */
  const returnToPlace = () => {
    const place = anchorRef.current ?? currentCfiRef.current;
    if (place) display(place, undefined, true);
  };

  const anchorForCfi = (cfi: string): Anchor | null => {
    const rendition = renditionRef.current;
    if (!rendition) return null;
    for (const contents of rendition.getContents() as unknown as Contents[]) {
      try {
        const range = contents.range(cfi);
        const frame = contents.document.defaultView?.frameElement;
        if (!range || !frame) continue;
        const rect = range.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        const offset = frame.getBoundingClientRect();
        return { x: offset.left + rect.left + rect.width / 2, top: offset.top + rect.top, bottom: offset.top + rect.bottom };
      } catch {
        // The CFI belongs to a section that is not rendered right now.
      }
    }
    return null;
  };

  // ---- Rendition lifecycle ----
  useEffect(() => {
    const host = hostRef.current!;
    const rendition = engine.book.renderTo(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      flow: flow === 'paginated' ? 'paginated' : 'scrolled-doc',
      spread: propsRef.current.spread ? 'auto' : 'none',
      minSpreadWidth: 760,
      // Safari delivers no events — no touches, taps or keys — from a frame that may not run scripts.
      // The book's own scripts stay switched off by the policy the engine puts into every chapter.
      allowScriptedContent: true,
      // epub.js would lay out again on its own after a rotation and return to the start of the page
      // instead of the reading place; the size watcher below does it properly.
      resizeOnOrientationChange: false,
    } as Parameters<typeof engine.book.renderTo>[1]);
    renditionRef.current = rendition;
    appliedRef.current = new Map();
    searchMarkRef.current = null;
    let lastWheel = 0;
    let atStart = false;
    let atEnd = false;
    let turning = false;
    let disposed = false;
    let settleToken = 0;

    // ---- Turning pages: the page follows the finger and slides, the way it does in a native reader ----
    const manager = () => (rendition as unknown as { manager?: PageManager }).manager;
    const paged = () => propsRef.current.flow === 'paginated';
    /** The chapter frames inside epub.js's container; moving them moves the page under the finger. */
    const viewElements = () => Array.from(manager()?.container.children ?? []).filter((el): el is HTMLElement => el instanceof HTMLElement);
    const shift = (px: number, transition = '', opacity = '') => {
      for (const el of viewElements()) {
        el.style.transition = transition;
        el.style.transform = px ? `translate3d(${px}px, 0, 0)` : '';
        el.style.opacity = opacity;
      }
    };
    const slide = async (px: number, ms: number, opacity = '') => {
      const first = viewElements()[0];
      if (!first) return;
      void first.offsetWidth;
      shift(px, `transform ${ms}ms ${EASE}, opacity ${ms}ms ease`, opacity);
      await wait(ms + 20);
    };
    /** Whether the chapter on screen has another page on that side, already laid out next to this one. */
    const hasPage = (dir: 1 | -1) => {
      const m = manager();
      if (!m) return false;
      const c = m.container;
      return dir > 0 ? c.scrollLeft + c.offsetWidth + m.layout.delta <= c.scrollWidth : c.scrollLeft > 0;
    };
    const bookEnds = (dir: 1 | -1) => (dir > 0 ? atEnd : atStart);

    const turn = async (dir: 1 | -1) => {
      const m = manager();
      if (!m || turning || disposed) return;
      // A page turn is the reader's move, even right after the book has opened.
      layoutRef.current = 0;
      const jump = () => (dir > 0 ? rendition.next() : rendition.prev());
      // Scrolled chapters, right-to-left books and reduced motion keep epub.js's own instant change.
      if (!paged() || m.settings.direction === 'rtl' || reducedMotion() || !m.layout.delta) {
        shift(0);
        await jump().catch(() => {});
        return;
      }
      turning = true;
      settleToken++;
      try {
        const width = m.layout.delta;
        if (hasPage(dir)) {
          await slide(-dir * width, 240);
          if (disposed) return;
          // Swap the visual shift for a real scroll within one frame, and let epub.js note the new place.
          shift(0);
          m.scrollBy(dir * width, 0, true);
          void rendition.reportLocation();
        } else if (bookEnds(dir)) {
          await slide(0, 180);
          shift(0);
        } else {
          // The neighbouring chapter is not laid out yet: this page leaves, then the new one comes in.
          await slide(-dir * width * 0.6, 150, '0');
          if (disposed) return;
          await Promise.race([jump().catch(() => {}), wait(4000)]);
          if (disposed) return;
          shift(dir * width * 0.25, '', '0');
          await slide(0, 220, '1');
          shift(0);
        }
      } finally {
        turning = false;
      }
    };
    turnRef.current = (dir) => void turn(dir);
    turningRef.current = () => turning;
    // The same page-follows-the-finger motion, driven from the app's own swipe bar.
    dragRef.current = {
      drag: (dx) => {
        if (turning || disposed || !paged() || manager()?.settings.direction === 'rtl') return;
        settleToken++;
        const dir = dx < 0 ? 1 : -1;
        shift(hasPage(dir) || !bookEnds(dir) ? dx : dx * 0.3);
      },
      release: (dx, ms) => {
        if (turning || disposed) return;
        const far = Math.abs(dx) > host.clientWidth * 0.18;
        const fast = Math.abs(dx) > 20 && Math.abs(dx) / Math.max(ms, 1) > 0.3;
        if (far || fast) {
          noteGesture('outcome', 'зона свайпу: гортаю');
          const rtl = manager()?.settings.direction === 'rtl';
          void turn(dx < 0 !== rtl ? 1 : -1);
          return;
        }
        noteGesture('outcome', 'зона свайпу: закороткий рух');
        const token = ++settleToken;
        void slide(0, 180).then(() => {
          if (token === settleToken && !turning) shift(0);
        });
      },
    };

    rendition.hooks.content.register((contents: Contents) => {
      const doc = contents.document;
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = contentCss(propsRef.current);
      doc.head.append(style);

      doc.addEventListener('keydown', (e) => propsRef.current.onKey(e));

      // A link to a footnote: shown in a popup instead of taking the reader away from the page.
      doc.addEventListener(
        'click',
        (e) => {
          const link = (e.target as Element | null)?.closest?.('a[href]');
          if (!link || !propsRef.current.onFootnote || !isNoteRef(link)) return;
          const href = link.getAttribute('href') ?? '';
          if (!href.includes('#')) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          const sectionHref = (contents as unknown as { section?: { href?: string } }).section?.href ?? engine.book.spine.get(contents.sectionIndex)?.href ?? '';
          void noteText(engine, doc, sectionHref, href).then((note) => {
            if (note) propsRef.current.onFootnote?.(note);
            else display(note === null ? resolveHref(sectionHref, href) : undefined);
          });
        },
        true,
      );

      doc.addEventListener('selectionchange', () => {
        const sel = doc.getSelection();
        if (!sel || sel.isCollapsed) propsRef.current.onSelection(null);
      });

      // ---- Touch ----
      const tap = { current: newTapState() };
      const hasSelection = () => {
        const sel = doc.getSelection();
        return Boolean(sel && !sel.isCollapsed);
      };
      let axis: 'x' | 'y' | null = null;
      let pinched = 1;

      /** A finger tap, worked out from the touch itself: Safari sends no click for a tap on plain text. */
      const fingerTap = (point: { x: number; y: number }) => {
        const origin = doc.defaultView?.frameElement?.getBoundingClientRect();
        const target = doc.elementFromPoint(point.x - (origin?.left ?? 0), point.y - (origin?.top ?? 0));
        // A link is followed by the browser itself.
        if (target?.closest?.('a[href]')) return;
        tapTakenRef.current = Date.now();
        // A highlight under the finger opens its menu.
        for (const mark of host.querySelectorAll<SVGGElement>('svg g[data-id]')) {
          const hit = Array.from(mark.children).some((part) => {
            const r = part.getBoundingClientRect();
            return point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
          });
          const annotation = hit ? propsRef.current.annotations.find((a) => a.id === mark.dataset.id) : undefined;
          if (!annotation) continue;
          const box = mark.getBoundingClientRect();
          return propsRef.current.onAnnotationClick(annotation, { x: box.left + box.width / 2, top: box.top, bottom: box.bottom });
        }
        const box = host.getBoundingClientRect();
        const zone = zoneOf((point.x - box.left) / box.width);
        noteGesture('outcome', `дотик: ${zone}`);
        propsRef.current.onTap?.(zone);
      };
      const handlers: { current: TouchHandlers } = {
        current: {
          start: () => {
            axis = null;
            pinched = 1;
            settleToken++;
          },
          move: (dx, dy) => {
            if (turning) return;
            if (!axis) {
              if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
              axis = Math.abs(dx) > Math.abs(dy) * 1.2 && !tap.current.hadSelection && !hasSelection() ? 'x' : 'y';
              if (axis === 'y' && !paged()) propsRef.current.onReadingGesture?.();
            }
            if (axis !== 'x' || !paged() || !propsRef.current.swipe || manager()?.settings.direction === 'rtl') return;
            const dir = dx < 0 ? 1 : -1;
            // At either end of the book the page resists instead of following the finger.
            shift(hasPage(dir) || !bookEnds(dir) ? dx : dx * 0.3);
          },
          end: (dx, _dy, ms, point) => {
            if (wasTap(tap.current, ms) && !hasSelection()) return fingerTap(point);
            if (axis !== 'x' || !paged() || turning || !propsRef.current.swipe) return;
            const far = Math.abs(dx) > host.clientWidth * 0.28;
            const fast = Math.abs(dx) > 24 && Math.abs(dx) / Math.max(ms, 1) > 0.4;
            if (far || fast) {
              const rtl = manager()?.settings.direction === 'rtl';
              noteGesture('outcome', 'свайп: гортаю');
              propsRef.current.onReadingGesture?.();
              void turn(dx < 0 !== rtl ? 1 : -1);
              return;
            }
            noteGesture('outcome', 'свайп закороткий — повертаю сторінку');
            const token = ++settleToken;
            void slide(0, 180).then(() => {
              if (token === settleToken && !turning) shift(0);
            });
          },
          cancel: () => {
            if (!turning) shift(0);
          },
          // Spreading two fingers enlarges the text, pinching makes it smaller.
          pinch: (factor) => {
            pinched *= factor;
            if (pinched < 1.18 && pinched > 0.85) return;
            propsRef.current.onPinch?.(pinched > 1 ? 1 : -1);
            pinched = 1;
          },
          swipe2: (dir) => {
            if (!propsRef.current.swipe2 || turning || disposed) return;
            const rtl = manager()?.settings.direction === 'rtl';
            noteGesture('outcome', `два пальці: гортаю ${dir > 0 ? 'вперед' : 'назад'}`);
            propsRef.current.onReadingGesture?.();
            void turn(rtl ? (-dir as 1 | -1) : dir);
          },
        },
      };
      attachTouch(doc, handlers, tap, {
        // The frame moves with the finger, so positions are taken relative to the app, not the frame.
        point: (t) => {
          const origin = doc.defaultView?.frameElement?.getBoundingClientRect();
          return { x: (origin?.left ?? 0) + t.clientX, y: (origin?.top ?? 0) + t.clientY };
        },
        hasSelection,
      });

      // A tap (or a click on the outer parts of a page) turns the page or shows the bars.
      doc.addEventListener('click', (e) => {
        // A finger tap has been handled already, from the touch.
        if (isTap(tap.current) || Date.now() - tapTakenRef.current < 600) return;
        if (hasSelection()) return;
        if ((e.target as Element | null)?.closest?.('a[href]')) return;
        const frame = doc.defaultView?.frameElement;
        if (!frame) return;
        const box = host.getBoundingClientRect();
        const zone = zoneOf((frame.getBoundingClientRect().left + e.clientX - box.left) / box.width);
        // epub.js reports a click on a highlight during this same click; that click opens the highlight's menu instead.
        setTimeout(() => {
          if (disposed || Date.now() - markClickedRef.current < 300) return;
          if (paged() && zone !== 'center') void turn(zone === 'left' ? -1 : 1);
        }, 0);
      });

      doc.addEventListener(
        'wheel',
        (e) => {
          if (!paged() || e.ctrlKey) return;
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          const now = Date.now();
          if (Math.abs(delta) < 12 || now - lastWheel < 350) return;
          lastWheel = now;
          void turn(delta > 0 ? 1 : -1);
        },
        { passive: true },
      );
    });

    rendition.on('relocated', (loc: Location) => {
      atStart = Boolean(loc.atStart);
      atEnd = Boolean(loc.atEnd);
      currentCfiRef.current = loc.start.cfi;
      const layout = layoutRef.current > 0;
      if (!layout) anchorRef.current = loc.start.cfi;
      const unit = loc.start.index;
      const exact = engine.percentageFromCfi(loc.start.cfi);
      const withinChapter = loc.start.displayed.total > 0 ? (loc.start.displayed.page - 1) / loc.start.displayed.total : 0;
      const percent = loc.atEnd ? 1 : (exact ?? (unit + withinChapter) / Math.max(1, engine.unitCount));
      propsRef.current.onRelocated({
        cfi: loc.start.cfi,
        endCfi: loc.end.cfi,
        unit,
        percent,
        chapterPage: loc.start.displayed.page,
        chapterPages: loc.start.displayed.total,
        layout,
      });
    });

    rendition.on('selected', (selectedCfi: string, contents: Contents) => {
      try {
        // A paragraph selected whole (a triple tap or click) has its ends on the paragraph element,
        // not inside its text; epub.js then works out a wrong position, and only the first character
        // came through. Such ends are moved into the text and the position worked out again.
        let cfiRange = selectedCfi;
        const live = contents.window.getSelection();
        if (live && !live.isCollapsed && live.rangeCount) {
          const own = live.getRangeAt(0);
          if (own.startContainer.nodeType !== Node.TEXT_NODE || own.endContainer.nodeType !== Node.TEXT_NODE) {
            const fixed = intoText(own);
            if (fixed) cfiRange = (contents as unknown as { cfiFromRange(r: Range): string }).cfiFromRange(fixed);
          }
        }
        const range = contents.range(cfiRange);
        const frame = contents.document.defaultView?.frameElement;
        const text = range?.toString().trim();
        if (!range || !frame || !text) return;
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
        const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
        const bounds = range.getBoundingClientRect();
        const offset = frame.getBoundingClientRect();
        propsRef.current.onSelection({
          text,
          unit: contents.sectionIndex,
          cfi: cfiRange,
          anchor: { x: offset.left + last.left + last.width / 2, top: offset.top + bounds.top, bottom: offset.top + last.bottom },
        });
      } catch {
        // Selection vanished before we could read it.
      }
    });

    display(anchorRef.current ?? undefined, undefined, true);

    let resizeHeld = false;
    const resize = debounce(() => {
      if (!host.clientWidth || !host.clientHeight) return;
      // The on-screen keyboard shrinks the app while a panel covers the book. Laying the chapter
      // out again for that, and once more when the keyboard closes, would only waste time.
      if (isTouchDevice && isTypingTarget(document.activeElement)) {
        resizeHeld = true;
        return;
      }
      // epub.js lays the chapter out for the new size and goes to the place given; by default that
      // is the start of the page shown, which is earlier than the reading place on a smaller screen.
      const place = anchorRef.current ?? currentCfiRef.current ?? undefined;
      layoutRef.current++;
      try {
        // (epub.js takes the place as a third argument; its type definitions leave it out.)
        (rendition as unknown as { resize(w: number, h: number, cfi?: string): void }).resize(host.clientWidth, host.clientHeight, place);
        // Queued after epub.js's own return to the place: until it is done, relocations are layout.
        returnToPlace();
      } catch {
        // epub.js throws if resized before the first section is displayed.
      } finally {
        layoutRef.current = Math.max(0, layoutRef.current - 1);
      }
    }, 150);
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const onFocusOut = () => {
      if (!resizeHeld) return;
      resizeHeld = false;
      resize();
    };
    window.addEventListener('focusout', onFocusOut);

    return () => {
      disposed = true;
      turnRef.current = () => {};
      turningRef.current = () => false;
      dragRef.current = { drag: () => {}, release: () => {} };
      window.removeEventListener('focusout', onFocusOut);
      observer.disconnect();
      resize.cancel();
      renditionRef.current = null;
      try {
        rendition.destroy();
      } catch {
        // epub.js may throw when destroyed mid-render.
      }
      host.replaceChildren();
    };
    // The rendition is rebuilt only when the book or the flow mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, flow]);

  // ---- Appearance ----
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    const css = contentCss({ theme, fontSize, font, lineHeight, flow, typography: props.typography, customFontUrl: props.customFontUrl });
    let changed = false;
    for (const contents of rendition.getContents() as unknown as Contents[]) {
      const style = contents.document.getElementById(STYLE_ID);
      if (style && style.textContent !== css) {
        style.textContent = css;
        changed = true;
      }
    }
    if (!changed) return;
    // Text metrics changed: let epub.js re-measure, return to the same place, and redraw the
    // highlight overlays, which epub.js only repositions when the frame itself is resized.
    const redrawMarks = () => {
      const views = renditionRef.current?.views() as unknown as { forEach?(fn: (view: { pane?: { render(): void } }) => void): void } | undefined;
      views?.forEach?.((view) => view.pane?.render());
    };
    const timers = [
      setTimeout(() => {
        returnToPlace();
        redrawMarks();
      }, 120),
      setTimeout(redrawMarks, 500),
    ];
    return () => timers.forEach(clearTimeout);
    // `flow` only feeds the stylesheet text: a change of flow rebuilds the whole view anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, fontSize, font, lineHeight, props.typography.align, props.typography.hyphens, props.typography.letterSpacing, props.typography.paragraphGap, props.customFontUrl]);

  // ---- Two pages side by side ----
  useEffect(() => {
    const rendition = renditionRef.current as unknown as { spread?(kind: string, min?: number): void; settings?: { spread?: string } } | null;
    const kind = props.spread ? 'auto' : 'none';
    if (!rendition?.spread || rendition.settings?.spread === kind) return;
    rendition.spread(kind, 760);
    // One page or two: the pages are cut differently, and the view returns to the reading place.
    returnToPlace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.spread]);

  // ---- Highlights and notes ----
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    const applied = appliedRef.current;
    const wanted = new Map<string, { a: Annotation; key: string }>();
    for (const a of annotations) {
      // Only range CFIs can be drawn; notes attached to a point just live in the notes list.
      if (a.type === 'bookmark' || !a.cfi?.includes(',')) continue;
      wanted.set(a.id, { a, key: `${a.cfi}|${a.color}|${a.type}|${theme}` });
    }

    for (const [id, key] of applied) {
      if (wanted.get(id)?.key === key) continue;
      try {
        rendition.annotations.remove(key.split('|')[0], 'highlight');
      } catch {
        // Already gone with its view.
      }
      applied.delete(id);
    }
    for (const [id, { a, key }] of wanted) {
      if (applied.has(id)) continue;
      const styles = {
        fill: HIGHLIGHT_COLORS[a.color],
        'fill-opacity': theme === 'dark' ? '0.3' : '0.45',
        'mix-blend-mode': theme === 'dark' ? 'screen' : 'multiply',
      };
      rendition.annotations.add(
        'highlight',
        a.cfi!,
        { id },
        (e?: Event) => {
          // epub.js also calls this when a finger merely lands on the highlight; wait for the tap itself,
          // or a swipe that starts on a highlight would open its menu.
          if (e?.type === 'touchstart') return;
          // …and a tap that has just been acted on (a page turn) must not open a highlight that slid under the finger.
          if (Date.now() - tapTakenRef.current < 600) return;
          markClickedRef.current = Date.now();
          // Look the annotation up at click time: its text may have been edited since it was drawn.
          const current = propsRef.current.annotations.find((x) => x.id === id);
          const anchor = anchorForCfi(a.cfi!);
          if (current && anchor) propsRef.current.onAnnotationClick(current, anchor);
        },
        a.type === 'note' ? 'zk-note' : 'zk-highlight',
        styles,
      );
      applied.set(id, key);
    }
  }, [annotations, theme, flow, engine]);

  // ---- Search result ----
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    if (searchMarkRef.current) {
      try {
        rendition.annotations.remove(searchMarkRef.current, 'underline');
      } catch {
        // Ignore.
      }
      searchMarkRef.current = null;
    }
    if (!activeHit?.cfi) return;
    searchMarkRef.current = activeHit.cfi;
    rendition.annotations.add('underline', activeHit.cfi, {}, undefined, 'zk-search-hit', {
      stroke: '#ff7a00',
      'stroke-opacity': '0.95',
      'stroke-width': '3px',
      fill: '#ff7a00',
      'fill-opacity': '0.25',
    });
    display(activeHit.cfi);
  }, [activeHit, flow, engine]);

  /** Resolves when no page turn is in flight. */
  const settled = async () => {
    for (let i = 0; i < 80 && turningRef.current(); i++) await new Promise((done) => setTimeout(done, 50));
  };

  useImperativeHandle(
    ref,
    () => ({
      next: () => turnRef.current(1),
      prev: () => turnRef.current(-1),
      drag: (dx) => dragRef.current.drag(dx),
      release: (dx, ms) => dragRef.current.release(dx, ms),
      goToCfi: (cfi, fallbackUnit) => display(cfi, fallbackUnit),
      goToHref: (href, fallbackUnit) => display(href, fallbackUnit),
      goToUnit: (unit) => {
        const section = engine.book.spine.get(unit);
        if (section) display(section.href);
      },
      goToPercent: (p) => {
        const cfi = engine.cfiFromPercentage(p);
        if (cfi) return display(cfi);
        // No location index yet: fall back to the nearest chapter.
        const unit = Math.min(engine.unitCount - 1, Math.floor(p * engine.unitCount));
        const section = engine.book.spine.get(unit);
        if (section) display(section.href);
      },
      pageKey: () => (renditionRef.current?.currentLocation() as unknown as Location | undefined)?.start?.cfi ?? '',
      visibleText: async () => {
        // While a page slides in, the chapter is not where it will be.
        await settled();
        const rendition = renditionRef.current;
        const box = (rendition as unknown as { manager?: PageManager } | null)?.manager?.container.getBoundingClientRect();
        if (!rendition || !box) return '';
        const pagedNow = propsRef.current.flow === 'paginated';
        let text = '';
        for (const contents of rendition.getContents() as unknown as Contents[]) {
          const frame = contents.document.defaultView?.frameElement?.getBoundingClientRect();
          if (!frame) continue;
          try {
            const part = textInWindow(contents.document, pagedNow ? { axis: 'x', from: box.left - frame.left, to: box.right - frame.left } : { axis: 'y', from: box.top - frame.top });
            text += text && part ? ` ${part}` : part;
          } catch {
            // A chapter that cannot be measured is skipped rather than stopping the voice.
          }
        }
        return text;
      },
      nextPage: async () => {
        // A turn made a moment ago may still be sliding in (a page with next to no text is over at once).
        await settled();
        return new Promise<boolean>((resolve) => {
          const rendition = renditionRef.current;
          const where = () => (rendition?.currentLocation() as unknown as (Location & { atEnd?: boolean }) | undefined) ?? null;
          const before = where();
          if (!rendition || !before?.start || before.atEnd) return resolve(false);
          let settled = false;
          const finish = (moved: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rendition.off('relocated', onMove);
            resolve(moved);
          };
          const onMove = (location: Location) => location.start.cfi !== before.start.cfi && finish(true);
          const timer = setTimeout(() => finish(where()?.start?.cfi !== before.start.cfi), 3000);
          rendition.on('relocated', onMove);
          turnRef.current(1);
        });
      },
      clearSelection: () => {
        for (const contents of (renditionRef.current?.getContents() ?? []) as unknown as Contents[]) {
          contents.document.getSelection()?.removeAllRanges();
        }
      },
    }),
    [engine],
  );

  return (
    <div className="epub-stage" style={{ background: READING_PALETTE[theme].bg }}>
      <div className="epub-host" ref={hostRef} />
    </div>
  );
});
