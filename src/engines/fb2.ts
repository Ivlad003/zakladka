// FictionBook (FB2) support: the file is turned into an EPUB on the device, once, when it is added,
// and from then on it is an ordinary EPUB to the rest of the app — reader, search, sync.
//
// FB2 is one XML file: a description (title, authors, cover), one or more bodies made of nested
// sections, and the pictures as base64 at the end. The second body, when there is one, holds notes.
import JSZip from 'jszip';

/** The FB2 document inside a file, or null when the file is not FB2 (plain, or zipped as .fb2.zip / .fbz). */
export async function readFb2(file: File): Promise<Uint8Array | null> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.fb2')) return new Uint8Array(await file.arrayBuffer());
  if (!/\.(fb2\.zip|fbz|zip)$/.test(name)) return null;
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith('.fb2'));
    return entry ? await entry.async('uint8array') : null;
  } catch {
    return null;
  }
}

/** FB2 files come in whatever encoding their XML declaration names — often windows-1251. */
function decodeXml(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = String.fromCharCode(...bytes.subarray(0, 200));
  const named = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(named).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const HTML_ENTITIES: Record<string, string> = { nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»', hellip: '…', copy: '©', shy: '­', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', deg: '°' };

/** Repairs what most often keeps an FB2 file from being valid XML: stray ampersands, HTML entities, control characters. */
function mendXml(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/&([a-zA-Z][\w]*);/g, (whole, name: string) => (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name) ? whole : (HTML_ENTITIES[name] ?? `&amp;${name};`)))
      .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
  );
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** FB2 ids are free text; XML ids and file names are not. */
const safeId = (id: string) => {
  const clean = id.replace(/[^\w.-]/g, '_');
  return /^[A-Za-z_]/.test(clean) ? clean : `x${clean}`;
};
const nameOf = (node: Element) => node.localName.toLowerCase();
const kids = (node: Element, name?: string) => Array.from(node.children).filter((c) => !name || nameOf(c) === name);
const hrefOf = (node: Element) => {
  for (const attr of Array.from(node.attributes)) if (attr.localName.toLowerCase() === 'href') return attr.value;
  return '';
};
const textOf = (node: Element | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

const INLINE: Record<string, string> = { emphasis: 'em', strong: 'strong', strikethrough: 's', sub: 'sub', sup: 'sup', code: 'code' };
const BLOCK: Record<string, [string, string?]> = {
  p: ['p'],
  subtitle: ['h4', 'subtitle'],
  epigraph: ['blockquote', 'epigraph'],
  cite: ['blockquote'],
  annotation: ['div', 'annotation'],
  'text-author': ['p', 'text-author'],
  poem: ['div', 'poem'],
  stanza: ['div', 'stanza'],
  v: ['p', 'v'],
  date: ['p', 'date'],
  table: ['table'],
  tr: ['tr'],
  td: ['td'],
  th: ['th'],
};

interface TocEntry {
  title: string;
  href: string;
  depth: number;
}

interface Picture {
  file: string;
  type: string;
  data: Uint8Array;
}

const STYLE = `body { line-height: 1.5; }
h1, h2, h3, h4 { text-align: center; line-height: 1.25; margin: 1.4em 0 0.8em; }
h4.subtitle { font-weight: bold; margin: 1em 0 0.5em; }
p { margin: 0; text-indent: 1.4em; text-align: justify; }
p.empty { text-indent: 0; }
blockquote { margin: 1em 0 1em 2em; }
blockquote.epigraph { margin-left: 35%; font-style: italic; }
p.text-author { text-align: right; font-style: italic; text-indent: 0; }
div.poem { margin: 1em 0 1em 2em; }
div.stanza { margin-bottom: 0.8em; }
p.v { text-indent: 0; text-align: left; }
div.image { text-align: center; margin: 1em 0; }
img { max-width: 100%; height: auto; }
a.note { vertical-align: super; font-size: 0.75em; text-decoration: none; }
div.annotation { font-style: italic; margin: 1em 0; }
p.series, p.authors { text-align: center; text-indent: 0; }
table { border-collapse: collapse; margin: 1em auto; } td, th { border: 1px solid #888; padding: 2px 6px; }
`;

const page = (title: string, lang: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(lang)}" xml:lang="${esc(lang)}">
<head><meta charset="UTF-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>`;

export interface Fb2Book {
  epub: Blob;
  title: string;
  author: string;
}

/** Converts an FB2 document into an EPUB. The result depends only on the input, byte for byte. */
export async function fb2ToEpub(bytes: Uint8Array): Promise<Fb2Book> {
  const parser = new DOMParser();
  const source = decodeXml(bytes);
  let doc = parser.parseFromString(source, 'application/xml');
  // Many FB2 files in the wild are not quite well-formed. The usual faults are mended and the file read again.
  if (doc.getElementsByTagName('parsererror').length) doc = parser.parseFromString(mendXml(source), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('файл FB2 пошкоджено: його XML не вдається розібрати');
  const root = doc.documentElement && nameOf(doc.documentElement) === 'fictionbook' ? doc.documentElement : null;
  if (!root) throw new Error('це не файл FB2');

  // ---- Description ----
  const info = Array.from(root.getElementsByTagName('*')).find((el) => nameOf(el) === 'title-info');
  const title = textOf(info && kids(info, 'book-title')[0]) || 'Без назви';
  const authors = (info ? kids(info, 'author') : [])
    .map((a) => ['first-name', 'middle-name', 'last-name'].map((part) => textOf(kids(a, part)[0])).filter(Boolean).join(' ') || textOf(kids(a, 'nickname')[0]))
    .filter(Boolean);
  const lang = textOf(info && kids(info, 'lang')[0]) || 'und';
  const series = info ? kids(info, 'sequence')[0] : undefined;
  const coverRef = info ? hrefOf(Array.from(info.getElementsByTagName('*')).find((el) => nameOf(el) === 'image') ?? info).replace(/^#/, '') : '';

  // ---- Pictures ----
  const pictures = new Map<string, Picture>();
  for (const binary of Array.from(root.getElementsByTagName('*')).filter((el) => nameOf(el) === 'binary')) {
    const id = binary.getAttribute('id');
    if (!id) continue;
    const type = (binary.getAttribute('content-type') ?? 'image/jpeg').toLowerCase().replace('image/jpg', 'image/jpeg');
    try {
      const raw = atob((binary.textContent ?? '').replace(/\s+/g, ''));
      const data = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
      const ext = type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'jpg';
      const base = safeId(id);
      pictures.set(id, { file: `images/${/\.\w{2,4}$/.test(base) ? base : `${base}.${ext}`}`, type, data });
    } catch {
      // A picture that does not decode is left out; the text is what matters.
    }
  }

  // ---- Text ----
  const files: { name: string; title: string; html: string }[] = [];
  const toc: TocEntry[] = [];
  /** Which file every anchor ended up in, to point links at. */
  const anchors = new Map<string, string>();
  let current = '';
  let counter = 0;

  const inline = (node: Node): string => {
    if (node.nodeType === 3) return esc(node.nodeValue ?? '');
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    const name = nameOf(el);
    const inner = () => Array.from(el.childNodes).map(inline).join('');
    if (INLINE[name]) return `<${INLINE[name]}>${inner()}</${INLINE[name]}>`;
    if (name === 'a') {
      const href = hrefOf(el);
      const note = el.getAttribute('type') === 'note';
      const target = href.startsWith('#') ? `fb2:${safeId(href.slice(1))}` : /^(https?:|mailto:)/i.test(href) ? href : '';
      return target ? `<a href="${esc(target)}"${note ? ' class="note" epub:type="noteref"' : ''}>${inner()}</a>` : inner();
    }
    if (name === 'image') {
      const picture = pictures.get(hrefOf(el).replace(/^#/, ''));
      return picture ? `<img src="${esc(picture.file)}" alt=""/>` : '';
    }
    if (name === 'style') return inner();
    return inner();
  };

  const withId = (el: Element) => {
    const id = el.getAttribute('id');
    if (!id) return '';
    anchors.set(safeId(id), current);
    return ` id="${esc(safeId(id))}"`;
  };

  const heading = (el: Element, depth: number): string => {
    const level = Math.min(6, Math.max(1, depth));
    const lines = kids(el)
      .filter((c) => nameOf(c) === 'p' || nameOf(c) === 'subtitle')
      .map((p) => Array.from(p.childNodes).map(inline).join(''))
      .filter((line) => line.trim());
    const text = lines.length ? lines.join('<br/>') : esc(textOf(el));
    return text ? `<h${level}>${text}</h${level}>\n` : '';
  };

  const block = (el: Element, depth: number): string => {
    const name = nameOf(el);
    if (name === 'section') return section(el, depth + 1);
    if (name === 'title') return heading(el, depth);
    if (name === 'empty-line') return '<p class="empty">&#160;</p>\n';
    if (name === 'image') {
      const picture = pictures.get(hrefOf(el).replace(/^#/, ''));
      return picture ? `<div class="image"${withId(el)}><img src="${esc(picture.file)}" alt="${esc(el.getAttribute('alt') ?? '')}"/></div>\n` : '';
    }
    const known = BLOCK[name];
    if (!known) return inline(el);
    const [tag, cls] = known;
    // Containers hold blocks; paragraphs and verse lines hold text.
    const leaf = name === 'p' || name === 'v' || name === 'subtitle' || name === 'text-author' || name === 'date' || name === 'td' || name === 'th';
    const inner = leaf ? Array.from(el.childNodes).map(inline).join('') : kids(el).map((c) => block(c, depth)).join('');
    return `<${tag}${cls ? ` class="${cls}"` : ''}${withId(el)}>${inner}</${tag}>\n`;
  };

  /** A title may take several lines ("Part One" / "Arrival"); in a list they read as one. */
  const sectionTitle = (el: Element) => {
    const heading = kids(el, 'title')[0];
    if (!heading) return '';
    const lines = kids(heading).map(textOf).filter(Boolean);
    return lines.length ? lines.join('. ').replace(/\.\. /g, '. ') : textOf(heading);
  };

  /** A section rendered in place, with its subsections inside it. */
  const section = (el: Element, depth: number): string => {
    const id = el.getAttribute('id') ? safeId(el.getAttribute('id')!) : `s${++counter}`;
    anchors.set(id, current);
    const name = sectionTitle(el);
    if (name) toc.push({ title: name, href: `${current}#${id}`, depth });
    return `<section id="${esc(id)}">\n${kids(el).map((c) => block(c, depth)).join('')}</section>\n`;
  };

  const emit = (name: string, pageTitle: string, render: () => string) => {
    current = name;
    const html = render();
    if (html.trim()) files.push({ name, title: pageTitle, html });
  };

  /** Headings of "part" sections that only hold chapters; they open the first chapter's file. */
  let prefix: { el: Element; depth: number }[] = [];
  let chapter = 0;
  const walk = (el: Element, depth: number) => {
    const subs = kids(el, 'section');
    if (subs.length === 0 || depth >= 2) {
      const lead = prefix;
      prefix = [];
      emit(`ch${String(++chapter).padStart(4, '0')}.xhtml`, sectionTitle(el) || title, () => {
        const before = lead
          .map((part) => {
            const id = part.el.getAttribute('id') ? safeId(part.el.getAttribute('id')!) : `s${++counter}`;
            anchors.set(id, current);
            const name = sectionTitle(part.el);
            if (name) toc.push({ title: name, href: `${current}#${id}`, depth: part.depth });
            return `<div id="${esc(id)}">\n${kids(part.el).filter((c) => nameOf(c) !== 'section').map((c) => block(c, part.depth)).join('')}</div>\n`;
          })
          .join('');
        return before + section(el, depth);
      });
      return;
    }
    prefix.push({ el, depth });
    for (const sub of subs) walk(sub, depth + 1);
  };

  const bodies = kids(root, 'body');
  const notes = bodies.filter((b, i) => i > 0 || /note|comment/i.test(b.getAttribute('name') ?? ''));
  const main = bodies.filter((b) => !notes.includes(b));

  // The title page: what the book is, and its annotation.
  emit('title.xhtml', title, () => {
    const annotation = info ? kids(info, 'annotation')[0] : undefined;
    const bodyTitle = main[0] ? kids(main[0], 'title')[0] : undefined;
    const epigraphs = main[0] ? kids(main[0], 'epigraph') : [];
    return [
      authors.length ? `<p class="authors">${esc(authors.join(', '))}</p>\n` : '',
      bodyTitle ? heading(bodyTitle, 1) : `<h1>${esc(title)}</h1>\n`,
      series?.getAttribute('name') ? `<p class="series">${esc(series.getAttribute('name')!)}${series.getAttribute('number') ? `, ${esc(series.getAttribute('number')!)}` : ''}</p>\n` : '',
      ...epigraphs.map((e) => block(e, 1)),
      annotation ? block(annotation, 1) : '',
    ].join('');
  });
  for (const body of main) {
    const sections = kids(body, 'section');
    if (sections.length) for (const s of sections) walk(s, 1);
    else emit(`ch${String(++chapter).padStart(4, '0')}.xhtml`, title, () => kids(body).filter((c) => !['title', 'epigraph'].includes(nameOf(c))).map((c) => block(c, 1)).join(''));
  }
  notes.forEach((body, i) => {
    const name = textOf(kids(body, 'title')[0]) || 'Примітки';
    emit(`notes${i + 1}.xhtml`, name, () => {
      toc.push({ title: name, href: current, depth: 1 });
      const before = toc.length;
      const html = `<h1>${esc(name)}</h1>\n${kids(body).filter((c) => nameOf(c) !== 'title').map((c) => block(c, 1)).join('')}`;
      // Each note is a section with a number for a title; a table of contents full of numbers helps nobody.
      toc.length = before;
      return html;
    });
  });
  if (!files.some((f) => f.name.startsWith('ch'))) throw new Error('у файлі FB2 немає тексту');

  // ---- The EPUB ----
  const zip = new JSZip();
  // A fixed date: the same FB2 must give the same EPUB on every device.
  const date = new Date(Date.UTC(2000, 0, 1));
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE', date });
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`, { date });
  zip.file('OEBPS/style.css', STYLE, { date });
  for (const file of files) {
    const html = file.html.replace(/href="fb2:([^"]+)"/g, (_, id: string) => `href="${anchors.get(id) === file.name ? '' : (anchors.get(id) ?? '')}#${id}"`);
    zip.file(`OEBPS/${file.name}`, page(file.title, lang, html), { date });
  }
  const used = [...pictures.values()];
  for (const picture of used) zip.file(`OEBPS/${picture.file}`, picture.data, { date });
  const cover = pictures.get(coverRef);

  const nav: string[] = [];
  let open = 0;
  for (const entry of toc) {
    const depth = Math.min(entry.depth, open + 1);
    if (depth > open) nav.push('<ol>');
    else nav.push('</li>', ...Array.from({ length: open - depth }, () => '</ol></li>'));
    open = depth;
    nav.push(`<li><a href="${esc(entry.href)}">${esc(entry.title)}</a>`);
  }
  if (open) nav.push('</li>', ...Array.from({ length: open - 1 }, () => '</ol></li>'), '</ol>');
  zip.file('OEBPS/nav.xhtml', page(title, lang, `<nav epub:type="toc" id="toc"><h1>Зміст</h1>\n${nav.join('\n') || `<ol><li><a href="${files[0].name}">${esc(title)}</a></li></ol>`}\n</nav>`), { date });

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...files.map((f, i) => `<item id="t${i}" href="${f.name}" media-type="application/xhtml+xml"/>`),
    ...used.map((p, i) => `<item id="${p === cover ? 'cover-image' : `i${i}`}" href="${esc(p.file)}" media-type="${esc(p.type)}"${p === cover ? ' properties="cover-image"' : ''}/>`),
  ];
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:fb2:${bytes.length}-${files.length}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
${authors.map((a) => `<dc:creator>${esc(a)}</dc:creator>`).join('\n')}
<dc:language>${esc(lang)}</dc:language>
<meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>
${cover ? '<meta name="cover" content="cover-image"/>' : ''}
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine>
${files.map((_, i) => `<itemref idref="t${i}"/>`).join('\n')}
</spine>
</package>`,
    { date },
  );
  const epub = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { epub, title, author: authors.join(', ') };
}
