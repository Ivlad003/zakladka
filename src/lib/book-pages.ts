// The pages of a book the app writes itself (lib/repo-book.ts): Markdown — a model's chapter, a
// repository's README — turned into the XHTML an EPUB holds, with diagrams drawn into pictures,
// code and diffs laid out, and nothing in it that could run.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { escapeXml } from '../engines/epub-build';

/** Characters XML does not allow; one of them in a chapter would make the whole chapter unreadable. */
const NOT_XML = /[^\x09\x0A\x0D\x20-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;
export const cleanText = (text: string): string => text.replace(NOT_XML, '');

export interface PageContext {
  /** Draws a Mermaid diagram into a picture of the book; null when it cannot be drawn. */
  drawDiagram(code: string): Promise<{ file: string; width: number } | null>;
  /** Brings a picture the text refers to into the book; null to leave it out. */
  loadImage(src: string): Promise<string | null>;
  /** Where a link should lead from inside the book; null to leave only its text. */
  resolveLink(href: string): string | null;
  /** Alternative text of a diagram ("Діаграма"), in the book's language. */
  diagramAlt: string;
}

export interface PageHeading {
  id: string;
  title: string;
}

/** A unified diff with added, removed and position lines marked, as XHTML. */
export function diffHtml(patch: string): string {
  const lines = cleanText(patch).replace(/\t/g, '  ').replace(/\n$/, '').split('\n');
  const body = lines
    .map((line) => {
      const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'ctx';
      // The line break stays inside the line's own element: the text of the page keeps its lines.
      return `<span class="${kind}">${escapeXml(line) || ' '}\n</span>`;
    })
    .join('');
  return `<pre class="diff">${body}</pre>`;
}

/** A source file as it is. */
export const codeHtml = (text: string): string => `<pre class="code"><code>${escapeXml(cleanText(text).replace(/\t/g, '  ').replace(/\n+$/, ''))}</code></pre>`;

const FORBIDDEN = ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'picture', 'svg', 'math', 'link', 'meta', 'base', 'script', 'noscript', 'template', 'canvas', 'dialog'];

/**
 * Markdown as the body of a page. Headings are brought down so that the highest of them is a
 * second-level one (the page's own title is the first level); those are returned for the contents.
 */
export async function markdownToXhtml(markdown: string, ctx: PageContext, idPrefix: string): Promise<{ body: string; headings: PageHeading[] }> {
  const html = marked.parse(cleanText(markdown), { async: false, gfm: true, breaks: false });
  const safe = DOMPurify.sanitize(html, { FORBID_TAGS: FORBIDDEN, FORBID_ATTR: ['style', 'srcset', 'sizes', 'loading', 'id', 'name', 'target', 'rel'] });
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><head></head><body>${safe}</body></html>`, 'text/html');
  const root = doc.body;

  // Pictures first: the diagrams drawn below are pictures too, and those are already in the book.
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    const file = src ? await ctx.loadImage(src) : null;
    if (file) {
      img.setAttribute('src', file);
      img.setAttribute('alt', img.getAttribute('alt') ?? '');
      continue;
    }
    // A picture left out takes with it the link that was only there to hold it, and an emptied paragraph.
    let hole: Element = img;
    while (hole.parentElement && hole.parentElement !== root && ['a', 'p', 'div', 'figure', 'span', 'center'].includes(hole.parentElement.localName) && !(hole.parentElement.textContent ?? '').trim() && hole.parentElement.querySelectorAll('img').length === 1) {
      hole = hole.parentElement;
    }
    hole.remove();
  }

  for (const code of Array.from(root.querySelectorAll('pre > code'))) {
    const pre = code.parentElement!;
    const lang = /(?:^|\s)language-([\w+#-]+)/.exec(code.getAttribute('class') ?? '')?.[1]?.toLowerCase() ?? '';
    const text = code.textContent ?? '';
    if (lang === 'mermaid') {
      const drawn = await ctx.drawDiagram(text);
      // A caption usually follows as a line in italics.
      const next = pre.nextElementSibling;
      const caption = next?.localName === 'p' && next.children.length === 1 && next.firstElementChild?.localName === 'em' && next.textContent === next.firstElementChild.textContent ? next : null;
      if (!drawn) {
        caption?.remove();
        pre.remove();
        continue;
      }
      const figure = doc.createElement('figure');
      figure.className = 'diagram';
      const img = doc.createElement('img');
      img.setAttribute('src', drawn.file);
      img.setAttribute('width', String(Math.round(drawn.width)));
      img.setAttribute('alt', caption?.textContent?.trim() || ctx.diagramAlt);
      figure.append(img);
      if (caption) {
        const cap = doc.createElement('figcaption');
        cap.textContent = caption.textContent;
        figure.append(cap);
        caption.remove();
      }
      pre.replaceWith(figure);
    } else if (lang === 'diff' || lang === 'patch') {
      const holder = doc.createElement('div');
      holder.innerHTML = diffHtml(text);
      pre.replaceWith(holder.firstElementChild!);
    } else {
      pre.className = 'code';
      code.removeAttribute('class');
      code.textContent = text.replace(/\t/g, '  ').replace(/\n+$/, '');
    }
  }

  for (const a of Array.from(root.querySelectorAll('a'))) {
    const href = a.getAttribute('href');
    const target = href ? ctx.resolveLink(href) : null;
    if (target) a.setAttribute('href', target);
    else a.replaceWith(...Array.from(a.childNodes));
  }

  // The page's own title is its only first-level heading.
  const all = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  const top = Math.min(6, ...all.map((h) => Number(h.localName[1])));
  const shift = top < 2 ? 2 - top : 0;
  const headings: PageHeading[] = [];
  for (const h of all) {
    const level = Math.min(6, Number(h.localName[1]) + shift);
    let el: Element = h;
    if (shift) {
      el = doc.createElement(`h${level}`);
      el.append(...Array.from(h.childNodes));
      h.replaceWith(el);
    }
    const title = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (level === 2 && title) {
      const id = `${idPrefix}-${headings.length + 1}`;
      el.setAttribute('id', id);
      headings.push({ id, title: title.slice(0, 120) });
    }
  }

  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.parentElement?.closest('table')) continue;
    const wrap = doc.createElement('div');
    wrap.className = 'table';
    table.replaceWith(wrap);
    wrap.append(table);
  }
  // Folded sections are shown unfolded: a page of a book has nothing to click.
  for (const details of Array.from(root.querySelectorAll('details'))) details.setAttribute('open', 'open');
  for (const el of Array.from(root.querySelectorAll('[align]'))) el.removeAttribute('align');

  const serializer = new XMLSerializer();
  const body = Array.from(root.childNodes)
    .map((node) => (node.nodeType === 1 ? serializer.serializeToString(node) : node.nodeType === 3 && node.nodeValue?.trim() ? `<p>${escapeXml(node.nodeValue)}</p>` : ''))
    .filter(Boolean)
    .join('\n');
  return { body: cleanText(body), headings };
}

/** The look of the book's pages. The reader's own choices (font, size, theme) are laid over it. */
export const BOOK_CSS = `body { line-height: 1.55; }
h1 { font-size: 1.7em; line-height: 1.2; margin: 0 0 0.6em; }
h2 { font-size: 1.3em; line-height: 1.25; margin: 1.5em 0 0.5em; }
h3 { font-size: 1.1em; margin: 1.3em 0 0.4em; }
h4, h5, h6 { font-size: 1em; margin: 1.2em 0 0.3em; }
p { margin: 0 0 0.8em; }
li { margin: 0.2em 0; }
a { text-decoration: underline; }
img { max-width: 100%; height: auto; }
figure { margin: 1.2em 0; text-align: center; break-inside: avoid; page-break-inside: avoid; }
figure.diagram img { background: #ffffff; border: 1px solid #d0d7de; border-radius: 6px; padding: 6px; box-sizing: border-box; }
figcaption { font-size: 0.85em; color: #666e78; margin-top: 0.4em; font-style: italic; }
blockquote { margin: 1em 0; padding: 0.1em 0 0.1em 0.9em; border-left: 3px solid #b8c0cc; }
code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace; }
code { font-size: 0.88em; background: #eff1f4; border-radius: 3px; padding: 0.05em 0.25em; overflow-wrap: anywhere; }
pre { font-size: 0.78em; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; margin: 1em 0; padding: 0.7em 0.8em; background: #f6f8fa; border: 1px solid #d8dee4; border-radius: 6px; text-align: left; hyphens: none; -webkit-hyphens: none; }
pre code { font-size: 1em; background: none; padding: 0; }
pre.diff { padding-left: 0; padding-right: 0; }
pre.diff span { display: block; padding: 0 0.6em; border-left: 4px solid transparent; }
pre.diff .add { background: #e6ffec; border-left-color: #2da44e; }
pre.diff .del { background: #ffebe9; border-left-color: #cf222e; }
pre.diff .hunk { background: #ddf4ff; border-left-color: #54aeff; color: #57606a; }
.table { margin: 1em 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.88em; }
td, th { border: 1px solid #c9d1d9; padding: 0.3em 0.5em; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: #f0f2f5; }
hr { border: 0; border-top: 1px solid #c9d1d9; margin: 1.5em 0; }
.cover { text-align: center; margin: 0; }
h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
.cover img { max-width: 100%; }
.book-title { font-size: 2em; margin: 1em 0 0.3em; }
.book-subtitle { font-size: 1.15em; margin: 0 0 1.2em; }
.book-meta, .note { font-size: 0.88em; color: #666e78; }
.kicker { font-size: 0.8em; letter-spacing: 0.12em; text-transform: uppercase; color: #666e78; margin: 0 0 0.4em; }
h1.path { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 1.15em; overflow-wrap: anywhere; }
.facts th { width: 34%; font-weight: 600; }
.stat .plus { color: #1a7f37; } .stat .minus { color: #cf222e; }
`;

/** A magazine issue: a lead under each headline, sidebars instead of plain quotations. */
export const MAGAZINE_CSS = `h1 { font-size: 2em; letter-spacing: -0.01em; }
.kicker { color: #b3261e; font-weight: 700; }
p.lead { font-size: 1.15em; line-height: 1.45; font-weight: 600; margin-bottom: 1.1em; }
blockquote { border-left: 0; border-top: 3px solid #b3261e; border-bottom: 1px solid #c9d1d9; padding: 0.6em 0 0.2em; margin: 1.4em 0; font-size: 1.05em; }
h2 { border-top: 1px solid #c9d1d9; padding-top: 0.7em; }
`;
