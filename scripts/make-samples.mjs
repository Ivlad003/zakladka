// Generates small test books into dev-samples/ (served by the dev server at /__samples/<file>).
// Run: node scripts/make-samples.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev-samples');
fs.mkdirSync(out, { recursive: true });

// ---------- PDF: three pages of text with an outline ----------
function makePdf() {
  const pages = [
    {
      title: 'Chapter 1. The Lighthouse',
      lines: [
        'The lighthouse keeper climbed the spiral stairs every evening.',
        'From the gallery he could see the whole bay and the fishing boats.',
        'He kept a notebook of weather, tides and passing ships.',
        'The word albatross appears here exactly once on this page.',
      ],
    },
    {
      title: 'Chapter 2. The Storm',
      lines: [
        'On the third night a storm came in from the north-west.',
        'The lamp burned steadily while waves broke over the rocks.',
        'A small schooner signalled for help near the reef.',
        'The keeper wrote: the albatross circled the tower twice at dawn.',
      ],
    },
    {
      title: 'Chapter 3. Morning',
      lines: [
        'By morning the sea was calm and the schooner was safe in harbour.',
        'The keeper closed his notebook and went down to make tea.',
        'Nothing in this chapter mentions the large sea bird.',
        'The end.',
      ],
    },
  ];
  const esc = (s) => s.replace(/([\\()])/g, '\\$1');
  const objects = [];
  const add = (body) => objects.push(body); // returns the 1-based object number
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageNums = [];
  for (const p of pages) {
    const filler = Array.from({ length: 18 }, (_, i) => `Line ${i + 1} of filler text so the page has enough words to select and search.`);
    const body = [...p.lines, '', ...filler].map((l) => `(${esc(l)}) Tj T*`);
    const text = [`BT /F1 20 Tf 72 740 Td (${esc(p.title)}) Tj ET`, 'BT /F1 12 Tf 72 700 Td 18 TL', ...body, 'ET'].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
    pageNums.push(
      add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`),
    );
  }
  const outlines = add('');
  const items = pages.map(() => add(''));
  pages.forEach((p, i) => {
    const prev = i > 0 ? ` /Prev ${items[i - 1]} 0 R` : '';
    const next = i < pages.length - 1 ? ` /Next ${items[i + 1]} 0 R` : '';
    objects[items[i] - 1] = `<< /Title (${esc(p.title)}) /Parent ${outlines} 0 R /Dest [${pageNums[i]} 0 R /Fit]${prev}${next} >>`;
  });
  objects[outlines - 1] = `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items.at(-1)} 0 R /Count ${items.length} >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>`;
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R /Outlines ${outlines} 0 R >>`;
  const info = add('<< /Title (The Lighthouse Keeper) /Author (Sample Author) >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(out, 'sample.pdf'), pdf, 'latin1');
}

// ---------- EPUB: three Ukrainian chapters ----------
async function makeEpub() {
  const chapters = [
    {
      id: 'ch1',
      title: 'Розділ 1. Маяк',
      paras: [
        'Доглядач маяка щовечора підіймався гвинтовими сходами на самий верх.',
        'З галереї було видно всю затоку й рибальські човни, що поверталися додому.',
        'Він вів зошит, куди записував погоду, припливи та кораблі, які проходили повз.',
        'Слово альбатрос трапляється в цьому розділі рівно один раз.',
      ],
    },
    {
      id: 'ch2',
      title: 'Розділ 2. Буря',
      paras: [
        'На третю ніч із північного заходу насунула буря.',
        'Лампа горіла рівно, поки хвилі розбивалися об скелі.',
        'Невелика шхуна подавала сигнал лиха біля рифу.',
        'Доглядач записав: на світанку альбатрос двічі облетів вежу.',
      ],
    },
    {
      id: 'ch3',
      title: 'Розділ 3. Ранок',
      paras: [
        'На ранок море заспокоїлося, а шхуна стояла в безпечній гавані.',
        'Доглядач закрив зошит і спустився заварити чай.',
        'У цьому розділі великий морський птах не згадується.',
        'Кінець.',
      ],
    },
  ];
  const fillerText =
    'Цей текст потрібен лише для того, щоб розділ займав кілька сторінок і можна було перевірити гортання, виділення фрагментів, нотатки та пошук у книзі. Море шуміло, вітер стихав, а світло маяка повільно оберталося над водою.';
  const filler = Array.from({ length: 14 }, (_, i) => `<p>Абзац ${i + 1}. ${fillerText}</p>`).join('\n');
  const head = '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n';
  const xhtml = (c) =>
    `${head}<html xmlns="http://www.w3.org/1999/xhtml" lang="uk"><head><title>${c.title}</title><link rel="stylesheet" href="style.css"/></head>\n` +
    `<body><h1>${c.title}</h1>\n${c.paras.map((p) => `<p>${p}</p>`).join('\n')}\n${filler}\n</body></html>`;

  const navItems = chapters.map((c) => `<li><a href="${c.id}.xhtml">${c.title}</a></li>`).join('');
  const manifestItems = chapters.map((c) => `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spineItems = chapters.map((c) => `<itemref idref="${c.id}"/>`).join('');

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file('OEBPS/style.css', 'body { font-family: serif; } h1 { font-size: 1.5em; } p { text-indent: 1.2em; margin: 0 0 .4em; }');
  for (const c of chapters) zip.file(`OEBPS/${c.id}.xhtml`, xhtml(c));
  zip.file(
    'OEBPS/nav.xhtml',
    `${head}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="uk"><head><title>Зміст</title></head><body><nav epub:type="toc"><h1>Зміст</h1><ol>${navItems}</ol></nav></body></html>`,
  );
  zip.file(
    'OEBPS/content.opf',
    '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:5b0c2f5e-0000-4000-8000-000000000001</dc:identifier>' +
      '<dc:title>Доглядач маяка</dc:title><dc:creator>Тестовий Автор</dc:creator><dc:language>uk</dc:language>' +
      '<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>\n' +
      `<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${manifestItems}</manifest>\n` +
      `<spine>${spineItems}</spine>\n</package>`,
  );
  fs.writeFileSync(path.join(out, 'sample.epub'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// ---------- "Scanned" PDF: pages are pictures of text with no text layer (for testing OCR) ----------
async function makeScanPdf() {
  const { default: sharp } = await import('sharp');
  const pages = [
    {
      title: 'Доглядач маяка',
      lines: [
        'Маяк стоїть на високій скелі над морем.',
        'Щовечора доглядач запалює лампу на вершині вежі.',
        'Кораблі бачать світло здалеку й обходять небезпечний риф.',
        'Узимку шторми тривають по кілька днів.',
        'Тоді над хвилями кружляє самотній альбатрос.',
      ],
    },
    {
      title: 'The Storm',
      lines: [
        'On the third night a storm came in from the north-west.',
        'The lamp burned steadily while waves broke over the rocks.',
        'A small schooner signalled for help near the reef.',
        'By morning the sea was calm again.',
      ],
    },
  ];
  const W = 1240;
  const H = 1754;
  const images = [];
  for (const p of pages) {
    const text = p.lines.map((l, i) => `<text x="110" y="${330 + i * 78}" font-size="40">${l}</text>`).join('');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Times New Roman, Georgia, serif" fill="#1a1a1a">` +
      `<rect width="100%" height="100%" fill="#f7f3e8"/><text x="110" y="200" font-size="64" font-weight="bold">${p.title}</text>${text}</svg>`;
    images.push(await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer());
  }

  // Binary-safe assembly: image streams are raw JPEG bytes.
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let length = parts[0].length;
  const addObject = (num, head, stream) => {
    offsets[num] = length;
    const chunks = [Buffer.from(`${num} 0 obj\n${head}\n`, 'latin1')];
    if (stream) chunks.push(Buffer.from('stream\n', 'latin1'), stream, Buffer.from('\nendstream\n', 'latin1'));
    chunks.push(Buffer.from('endobj\n', 'latin1'));
    for (const c of chunks) {
      parts.push(c);
      length += c.length;
    }
  };
  // 1 catalog, 2 pages, then per page: page, content, image.
  const pageObj = (i) => 3 + i * 3;
  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObject(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  images.forEach((jpeg, i) => {
    const n = pageObj(i);
    const content = Buffer.from('q 595 0 0 842 0 0 cm /Im0 Do Q', 'latin1');
    addObject(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    addObject(n + 1, `<< /Length ${content.length} >>`, content);
    addObject(
      n + 2,
      `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
      jpeg,
    );
  });
  const count = 2 + pages.length * 3;
  const xref = length;
  let tail = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= count; n++) tail += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(Buffer.from(tail, 'latin1'));
  fs.writeFileSync(path.join(out, 'sample-scan.pdf'), Buffer.concat(parts));
}

makePdf();
await makeEpub();
await makeScanPdf().catch((err) => console.warn('scan sample skipped:', err.message));
console.log('samples written to dev-samples/:', fs.readdirSync(out).join(', '));
