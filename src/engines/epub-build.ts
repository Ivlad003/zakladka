// Putting an EPUB together in memory. Formats that are one file of marked-up text with pictures
// (FB2, MOBI) are converted into an EPUB when they are added, and read by the EPUB engine after that.
import JSZip from 'jszip';

export const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface EpubToc {
  title: string;
  /** File name, optionally with `#anchor`. */
  href: string;
  /** 1 for a top-level entry. */
  depth: number;
}

export interface EpubParts {
  /** Goes into the package identifier; anything stable for the same input. */
  id: string;
  title: string;
  authors: string[];
  lang: string;
  css: string;
  /** Chapters in reading order: file name, title, and the XHTML that goes inside `<body>`. */
  files: { name: string; title: string; body: string }[];
  images: { file: string; type: string; data: Uint8Array }[];
  /** File name of the cover among `images`. */
  cover?: string;
  toc: EpubToc[];
  /** Heading of the contents page; "Зміст" when not given. */
  tocTitle?: string;
}

const page = (title: string, lang: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">
<head><meta charset="UTF-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>`;

/** The EPUB as a file. The result depends only on the input, byte for byte: the same book gets the same file on every device. */
export async function buildEpub(parts: EpubParts): Promise<Blob> {
  const { title, lang, files, images, toc } = parts;
  const zip = new JSZip();
  const date = new Date(Date.UTC(2000, 0, 1));
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE', date });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    { date },
  );
  zip.file('OEBPS/style.css', parts.css, { date });
  for (const file of files) zip.file(`OEBPS/${file.name}`, page(file.title, lang, file.body), { date });
  for (const image of images) zip.file(`OEBPS/${image.file}`, image.data, { date });

  const nav: string[] = [];
  let open = 0;
  for (const entry of toc) {
    const depth = Math.max(1, Math.min(entry.depth, open + 1));
    if (depth > open) nav.push('<ol>');
    else nav.push('</li>', ...Array.from({ length: open - depth }, () => '</ol></li>'));
    open = depth;
    nav.push(`<li><a href="${escapeXml(entry.href)}">${escapeXml(entry.title)}</a>`);
  }
  if (open) nav.push('</li>', ...Array.from({ length: open - 1 }, () => '</ol></li>'), '</ol>');
  zip.file(
    'OEBPS/nav.xhtml',
    page(title, lang, `<nav epub:type="toc" id="toc"><h1>${escapeXml(parts.tocTitle ?? 'Зміст')}</h1>\n${nav.join('\n') || `<ol><li><a href="${files[0].name}">${escapeXml(title)}</a></li></ol>`}\n</nav>`),
    { date },
  );

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...files.map((f, i) => `<item id="t${i}" href="${f.name}" media-type="application/xhtml+xml"/>`),
    ...images.map((p, i) => `<item id="${p.file === parts.cover ? 'cover-image' : `i${i}`}" href="${escapeXml(p.file)}" media-type="${escapeXml(p.type)}"${p.file === parts.cover ? ' properties="cover-image"' : ''}/>`),
  ];
  const hasCover = images.some((p) => p.file === parts.cover);
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">${escapeXml(parts.id)}</dc:identifier>
<dc:title>${escapeXml(title)}</dc:title>
${parts.authors.map((a) => `<dc:creator>${escapeXml(a)}</dc:creator>`).join('\n')}
<dc:language>${escapeXml(lang)}</dc:language>
<meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>
${hasCover ? '<meta name="cover" content="cover-image"/>' : ''}
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
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
