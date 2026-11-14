// Web articles saved to read later: the page is fetched by the app's own server (a browser may not
// read another site), the article is picked out of it with Mozilla's Readability (the code behind
// Firefox's Reader View), its pictures are kept with it, and the result becomes an EPUB on the shelf
// "Статті" — readable offline, with notes, highlights, search and the agents like any book.
import { db } from '../db';
import { buildEpub, escapeXml } from '../engines/epub-build';
import { importBooks } from './library';
import { guessLang } from './read-aloud';
import { timeoutSignal } from './utils';

export const ARTICLES_SHELF = 'Статті';

export interface SaveProgress {
  step: string;
}

const STYLE = `body { line-height: 1.55; }
h1 { font-size: 1.6em; line-height: 1.2; margin: 0 0 0.3em; }
.byline { color: #777; font-size: 0.9em; margin: 0 0 1.4em; }
.byline a { color: inherit; }
p { margin: 0 0 0.8em; }
img, figure img { max-width: 100%; height: auto; }
figure { margin: 1em 0; }
figcaption { font-size: 0.85em; color: #777; }
blockquote { margin: 1em 0 1em 1.2em; padding-left: 0.8em; border-left: 3px solid #ccc; }
pre { white-space: pre-wrap; font-size: 0.85em; }
table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: 2px 6px; }
`;

/** The first web address in a piece of text (what a "share" from another app usually carries). */
export const findUrl = (text: string): string | null => /https?:\/\/[^\s<>"']+/i.exec(text)?.[0]?.replace(/[),.;!?»]+$/, '') ?? null;

async function viaServer(path: string): Promise<Response> {
  const res = await fetch(path, { signal: timeoutSignal(25000) });
  if (res.status === 404 || !(res.headers.get('content-type') ?? '').length) {
    throw new Error('Зберігати статті можна, коли застосунок відкрито через його сервер (npm run serve): браузер сам не може завантажити чужу сторінку.');
  }
  return res;
}

/** The server's reason (in English, shared with the agents' web tools) told in the reader's words. */
function serverError(error: string | undefined, status: number): string {
  const site = /The site answered (\d+)/.exec(error ?? '')?.[1];
  if (/not on the public internet/.test(error ?? '')) return 'Ця адреса не в інтернеті (домашня мережа чи сам комп’ютер) — такі сторінки сервер не відкриває.';
  if (/Only http and https/.test(error ?? '')) return 'Потрібна адреса, що починається з http:// або https://.';
  if (/not a web page/.test(error ?? '')) return 'За цією адресою не вебсторінка (а, наприклад, файл). Файл книги додайте через «Книги з пристрою».';
  if (site === '401' || site === '403') return `Сайт не пускає (${site}): можливо, сторінка лише для тих, хто увійшов, або сайт не віддає сторінки автоматичним запитам.`;
  if (site === '404') return 'Такої сторінки на сайті немає (404). Перевірте адресу.';
  if (site) return `Сайт відповів помилкою ${site}. Спробуйте пізніше.`;
  if (/redirects/.test(error ?? '')) return 'Сайт пересилає з адреси на адресу без кінця.';
  if (/timeout|timed out|aborted|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(error ?? '')) return 'Сайт не відповідає або такої адреси немає.';
  return `Не вдалося завантажити сторінку${error ? ` (${error})` : ` (сервер відповів ${status})`}.`;
}

const NOISE = [
  '#siteSub', '#contentSub', '#contentSub2', '#jump-to-nav', '.mw-indicators', '.mw-editsection', '.hatnote', '.dablink',
  '.ambox', '.metadata', '.navbox', '.vertical-navbox', '.sistersitebox', '.noprint', '#toc', '.toc', '.mw-jump-link',
  '[class*="flaggedrevs"]', '#mw-fr-revisiontag', '.mw-fr-revision', '[role="navigation"]', '.share-buttons', '.social-share',
].join(', ');

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };

/** Saves the article at `url` as a book; resolves to the new book's id. */
export async function saveArticle(url: string, onProgress: (p: SaveProgress) => void): Promise<string> {
  onProgress({ step: 'Завантажую сторінку…' });
  const res = await viaServer(`/web/page?${new URLSearchParams({ url })}`);
  const page = (await res.json().catch(() => ({}))) as { url?: string; html?: string; error?: string };
  if (!res.ok || !page.html) throw new Error(serverError(page.error, res.status));
  const base = page.url ?? url;

  onProgress({ step: 'Виділяю статтю…' });
  const doc = new DOMParser().parseFromString(page.html, 'text/html');
  const baseEl = doc.createElement('base');
  baseEl.href = base;
  doc.head.prepend(baseEl);
  // Lazy-loaded pictures keep their real address in data attributes.
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const real = img.getAttribute('data-src') ?? img.getAttribute('data-original') ?? img.getAttribute('data-lazy-src');
    if (real) img.setAttribute('src', real);
  }
  // Notices sites put above and around an article (Wikipedia's "from Wikipedia…", review flags,
  // "for other uses see…", edit links, navigation boxes) are not part of it.
  for (const el of Array.from(doc.querySelectorAll(NOISE))) el.remove();
  const { Readability } = await import('@mozilla/readability');
  const article = new Readability(doc, { charThreshold: 300 }).parse();
  if (!article?.content) throw new Error('На цій сторінці не вдалося знайти статтю.');
  const title = (article.title || doc.title || new URL(base).hostname).trim();

  // The article's body, made safe and absolute.
  const body = new DOMParser().parseFromString(`<!DOCTYPE html><html><head><base href="${escapeXml(base)}"></head><body>${article.content}</body></html>`, 'text/html');
  for (const el of Array.from(body.querySelectorAll('script, style, iframe, object, embed, form, input, button, noscript, svg, video, audio, source, picture > source'))) el.remove();
  for (const el of Array.from(body.body.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'srcset' || name === 'sizes' || name.startsWith('data-') || name === 'class' || name === 'id' || !/^[a-z][a-z0-9-]*$/.test(name)) el.removeAttribute(attr.name);
    }
    if (el.localName === 'a') {
      const href = (el as HTMLAnchorElement).href;
      if (/^https?:/.test(href)) el.setAttribute('href', href);
      else el.removeAttribute('href');
    }
  }

  // Pictures are kept with the article, so that it reads offline too.
  const images: { file: string; type: string; data: Uint8Array }[] = [];
  const pictures = Array.from(body.body.querySelectorAll('img'));
  let n = 0;
  for (const img of pictures) {
    const src = (img as HTMLImageElement).src;
    if (!/^https?:/.test(src) || n >= 40) {
      img.remove();
      continue;
    }
    onProgress({ step: `Зберігаю картинки: ${n + 1} з ${Math.min(40, pictures.length)}…` });
    try {
      const pic = await fetch(`/web/fetch?${new URLSearchParams({ url: src })}`, { signal: timeoutSignal(15000) });
      const type = pic.headers.get('content-type') ?? '';
      if (!pic.ok || !type.startsWith('image/')) throw new Error('not a picture');
      const file = `images/p${String(++n).padStart(3, '0')}.${EXT[type.split(';')[0]] ?? 'img'}`;
      images.push({ file, type: type.split(';')[0], data: new Uint8Array(await pic.arrayBuffer()) });
      img.setAttribute('src', file);
      img.setAttribute('alt', img.getAttribute('alt') ?? '');
    } catch {
      img.remove();
    }
  }

  onProgress({ step: 'Складаю книгу…' });
  const serializer = new XMLSerializer();
  const content = Array.from(body.body.childNodes)
    .map((node) => (node.nodeType === 1 ? serializer.serializeToString(node) : node.nodeType === 3 && node.nodeValue?.trim() ? `<p>${escapeXml(node.nodeValue)}</p>` : ''))
    .join('\n');
  const site = article.siteName || new URL(base).hostname.replace(/^www\./, '');
  const byline = [article.byline, site].filter(Boolean).join(' · ');
  const saved = new Date().toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
  const headings = Array.from(body.body.querySelectorAll('h2, h3')).map((h, i) => ({ title: (h.textContent ?? '').trim().slice(0, 100), i })).filter((h) => h.title);
  const epub = await buildEpub({
    id: `urn:article:${base}`,
    title,
    authors: article.byline ? [article.byline.trim()] : [site],
    lang: article.lang || guessLang(article.textContent ?? ''),
    css: STYLE,
    files: [
      {
        name: 'article.xhtml',
        title,
        body: `<h1>${escapeXml(title)}</h1>\n<p class="byline">${escapeXml(byline)} · <a href="${escapeXml(base)}">оригінал</a> · збережено ${escapeXml(saved)}</p>\n${content}`,
      },
    ],
    images,
    cover: images[0]?.file,
    toc: [{ title, href: 'article.xhtml', depth: 1 }, ...headings.slice(0, 40).map((h) => ({ title: h.title, href: 'article.xhtml', depth: 2 }))],
  });

  const name = `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'article'}.epub`;
  const result = await importBooks([new File([epub], name, { type: 'application/epub+zip' })]);
  const id = result.ids[0];
  if (!id) throw new Error(result.errors[0] ?? 'Не вдалося зберегти статтю.');
  const book = await db.books.get(id);
  if (book) {
    await db.books.update(id, {
      title,
      author: byline,
      sourceUrl: base,
      tags: [...new Set([...(book.tags ?? []), ARTICLES_SHELF])],
      infoAt: Date.now(),
    });
  }
  return id;
}
