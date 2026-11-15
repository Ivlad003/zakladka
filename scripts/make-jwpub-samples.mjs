// Test publications in JW Library's format, written from the open descriptions of it:
//   dev-samples/sample.jwpub        an ordinary publication: a table of contents with a section,
//                                   pictures, footnotes, links between documents, a link to a
//                                   verse (which cannot work outside JW Library), a box for typing
//                                   an answer, a long document that does not fit a database page,
//                                   and a cover in the manifest
//   dev-samples/sample-bible.jwpub  a publication with Bible books: chapters with verse numbers,
//                                   footnotes filed under the book, a link from a document to a
//                                   verse, and an issue title of its own
// The texts are made up for the test. They exercise the reader's converter; they are not a
// substitute for trying real files.
//
// The database inside is SQLite, which Node 20 cannot write, so that one step is done by Python's
// standard library: `python` (or `py`) has to be on the PATH.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(project, 'dev-samples');
const require = createRequire(path.join(project, 'package.json'));
const JSZip = require('jszip');
const sharp = require('sharp');

// ---- Encryption: the key comes from what the publication is ----
const MASK = Buffer.from('11cbb5587e32846d4c26790c633da289f66fe5842a3a585ce1bc3a294af5ada7', 'hex');
function cipher(language, symbol, year, issue = 0) {
  const card = [language, symbol, year, ...(issue ? [issue] : [])].join('_');
  const material = crypto.createHash('sha256').update(card).digest().map((byte, i) => byte ^ MASK[i]);
  return { key: material.subarray(0, 16), iv: material.subarray(16) };
}
function pack(html, { key, iv }) {
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([c.update(zlib.deflateSync(Buffer.from(html, 'utf8'))), c.final()]);
}

// ---- The database: tables as JW Library declares them (the columns the reader does not use are kept, so the rows look real) ----
const SCHEMA = [
  `CREATE TABLE "Publication" ("PublicationId" INTEGER, "VersionNumber" INTEGER, "Type" INTEGER, "Title" TEXT, "TitleRich" TEXT, "RootSymbol" TEXT, "RootYear" INTEGER, "RootMepsLanguageIndex" INTEGER, "ShortTitle" TEXT, "Symbol" TEXT NOT NULL, "UniqueEnglishSymbol" TEXT NOT NULL, "IssueTagNumber" TEXT, "Year" INTEGER NOT NULL, "MepsLanguageIndex" INTEGER NOT NULL, "PublicationType" TEXT, PRIMARY KEY("PublicationId"))`,
  `CREATE TABLE "Document" ("DocumentId" INTEGER, "PublicationId" INTEGER, "MepsDocumentId" INTEGER, "MepsLanguageIndex" INTEGER, "Class" TEXT, "Type" INTEGER, "SectionNumber" INTEGER, "ChapterNumber" INTEGER, "Title" TEXT, "TitleRich" TEXT, "TocTitle" TEXT, "TocTitleRich" TEXT, "ContextTitle" TEXT, "Content" BLOB, "FirstFootnoteId" INTEGER, "LastFootnoteId" INTEGER, "ParagraphCount" INTEGER, "ContentLength" INTEGER, FOREIGN KEY("PublicationId") REFERENCES "Publication"("PublicationId"), PRIMARY KEY("DocumentId"))`,
  `CREATE TABLE "Footnote" ("FootnoteId" INTEGER, "DocumentId" INTEGER, "FootnoteIndex" INTEGER, "Type" INTEGER, "Content" BLOB, "BibleVerseId" INTEGER, "ParagraphOrdinal" INTEGER, FOREIGN KEY("DocumentId") REFERENCES "Document"("DocumentId"), PRIMARY KEY("FootnoteId"))`,
  `CREATE TABLE "Multimedia" ("MultimediaId" INTEGER, "DataType" INTEGER, "MajorType" INTEGER, "MinorType" INTEGER, "Width" INTEGER, "Height" INTEGER, "MimeType" TEXT, "Label" TEXT, "Caption" TEXT, "CategoryType" INTEGER, "FilePath" TEXT, PRIMARY KEY("MultimediaId"))`,
  `CREATE TABLE "PublicationView" ("PublicationViewId" INTEGER, "Name" TEXT, "Symbol" TEXT NOT NULL UNIQUE, PRIMARY KEY("PublicationViewId"))`,
  `CREATE TABLE "PublicationViewItem" ("PublicationViewItemId" INTEGER, "PublicationViewId" INTEGER, "ParentPublicationViewItemId" INTEGER, "Title" TEXT, "TitleRich" TEXT, "SchemaType" INTEGER, "ChildTemplateSchemaType" INTEGER, "DefaultDocumentId" INTEGER, FOREIGN KEY("PublicationViewId") REFERENCES "PublicationView"("PublicationViewId"), PRIMARY KEY("PublicationViewItemId"))`,
  `CREATE TABLE "PublicationViewItemDocument" ("PublicationViewItemDocumentId" INTEGER, "PublicationViewItemId" INTEGER, "DocumentId" INTEGER, PRIMARY KEY("PublicationViewItemDocumentId"))`,
  `CREATE TABLE "BibleBook" ("BibleBookId" INTEGER, "PublicationId" INTEGER, "BookDocumentId" INTEGER, "IntroDocumentId" INTEGER, "OverviewDocumentId" INTEGER, "OutlineDocumentId" INTEGER, "BookDisplayTitle" TEXT, "ChapterDisplayTitle" TEXT, PRIMARY KEY("BibleBookId"))`,
  `CREATE TABLE "BibleChapter" ("BibleChapterId" INTEGER, "BookNumber" INTEGER, "ChapterNumber" INTEGER, "Content" BLOB, "FirstVerseId" INTEGER, "LastVerseId" INTEGER, PRIMARY KEY("BibleChapterId"))`,
  `CREATE TABLE "PublicationIssueProperty" ("PublicationIssuePropertyId" INTEGER, "PublicationId" INTEGER, "Title" TEXT, "TitleRich" TEXT, "UndatedTitle" TEXT, "CoverTitle" TEXT, "Symbol" TEXT, "UndatedSymbol" TEXT, PRIMARY KEY("PublicationIssuePropertyId"))`,
  `CREATE TABLE "Word" ("WordId" INTEGER, "Word" TEXT NOT NULL, PRIMARY KEY("WordId"))`,
];
const BUILD = `
import base64, json, sqlite3, sys
job = json.loads(sys.stdin.buffer.read().decode("utf-8"))
db = sqlite3.connect(job["path"])
db.execute("PRAGMA page_size=4096")
for statement in job["schema"]:
    db.execute(statement)
for table, rows in job["rows"].items():
    for row in rows:
        names = list(row.keys())
        values = [base64.b64decode(v["b64"]) if isinstance(v, dict) else v for v in row.values()]
        db.execute('INSERT INTO "%s" (%s) VALUES (%s)' % (table, ",".join('"%s"' % n for n in names), ",".join("?" * len(names))), values)
db.commit()
db.close()
`;
function database(rows) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jwpub-')), 'publication.db');
  const job = JSON.stringify({ path: file, schema: SCHEMA, rows }, (_, v) => (v?.type === 'Buffer' ? { b64: Buffer.from(v.data).toString('base64') } : v));
  for (const python of ['python', 'py', 'python3']) {
    const run = spawnSync(python, ['-c', BUILD], { input: job, encoding: 'utf8' });
    if (run.error) continue;
    if (run.status !== 0) throw new Error(`python: ${run.stderr}`);
    const bytes = fs.readFileSync(file);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    return bytes;
  }
  throw new Error('Потрібен Python (python або py у PATH): базу даних SQLite для тестового JWPUB створює він.');
}

async function jwpub(name, publication, rows, pictures, images = []) {
  const db = database(rows);
  const date = new Date(Date.UTC(2026, 0, 1));
  const contents = new JSZip();
  contents.file(`${publication.symbol}.db`, db, { date });
  for (const [file, data] of Object.entries(pictures)) contents.file(file, data, { date });
  const inner = await contents.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const outer = new JSZip();
  outer.file(
    'manifest.json',
    JSON.stringify({
      name: `${publication.symbol}.jwpub`,
      hash: crypto.createHash('sha256').update(inner).digest('hex'),
      timestamp: '2026-01-01T00:00:00Z',
      version: 1,
      contentFormat: 'z-a',
      publication: { fileName: `${publication.symbol}.db`, type: 1, title: publication.title, symbol: publication.symbol, year: publication.year, language: publication.language, images },
    }),
    { date },
  );
  outer.file('contents', inner, { date, compression: 'STORE' });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, name), await outer.generateAsync({ type: 'nodebuffer' }));
  console.log(`${name}: ${fs.statSync(path.join(out, name)).size} bytes, database ${db.length} bytes`);
}

const drawing = (label, w, h, color) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/><circle cx="${w / 2}" cy="${h * 0.42}" r="${Math.min(w, h) * 0.2}" fill="#f6e7c1"/><text x="50%" y="82%" font-family="Georgia, serif" font-size="${Math.round(w / 12)}" fill="#fff" text-anchor="middle">${label}</text></svg>`))
    .jpeg({ quality: 82 })
    .toBuffer();

/** Text that does not compress into nothing: every paragraph is different. */
const WORDS = 'маяк хвиля берег туман ліхтар журнал канат вітер скеля причал човен світло ніч ранок сіль пісок чайка компас сходи вежа гас лінза дзвін шторм тиша стежка камінь мох вогонь зоря'.split(' ');
function longText(paragraphs, from) {
  let seed = 20261115;
  const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  return Array.from({ length: paragraphs }, (_, i) => {
    const words = Array.from({ length: 40 + Math.floor(next() * 30) }, () => WORDS[Math.floor(next() * WORDS.length)] + (next() < 0.08 ? String(Math.floor(next() * 9000)) : ''));
    return `<p id="p${from + i}" data-pid="${from + i}" class="sb">Запис ${i + 1}. ${words.join(' ')}.</p>`;
  }).join('\n');
}

// ---- An ordinary publication ----
{
  const publication = { language: 222, symbol: 'zkt', year: 2026, title: 'Довідник доглядача маяка' };
  const c = cipher(publication.language, publication.symbol, publication.year);
  const docs = [
    {
      id: 0,
      meps: 1102026100,
      title: 'Титульна сторінка',
      html: `<header><h1 id="p1" data-pid="1"><strong>Довідник доглядача маяка</strong></h1></header><div class="bodyTxt"><p id="p2" data-pid="2" class="sb">Тестове видання для читалки «Закладка».</p><p id="p3" data-pid="3"><img src="jwpub-media://zkt_K_cnt_1.jpg" alt="Маяк на мисі" class="east_right"/></p></div>`,
    },
    {
      id: 1,
      meps: 1102026101,
      title: 'Розділ 1. Світло',
      toc: 'Світло',
      html: `<header><p class="contextTtl">РОЗДІЛ 1</p><h1 id="p1" data-pid="1"><strong>Світло</strong></h1><p id="p2" data-pid="2" class="themeScrp"><em>«Світло видно здалеку»</em> (<a href="jwpub://b/NWTR/40:5:14-40:5:14" class="b">Матвія 5:14</a>).</p></header>
<div class="bodyTxt"><div id="section1" class="section">
<p id="p3" data-pid="3" class="qu"><strong>1.</strong> Навіщо запалюють ліхтар?</p>
<div class="gen-field" id="p7" data-pid="7"><label for="tt2" id="tt1" class="dc-screenReaderText">Відповідь</label><textarea id="tt2" class="du-width--full"></textarea></div>
<p id="p4" data-pid="4" class="sb"><span id="page5" class="pageNum" aria-hidden="true">5</span>Ліхтар запалюють на заході сонця<a class="fn" data-fnid="1" href="jwpub://f/K:1102026101/1">*</a>. Гас зберігають у льоху<span class="fn" data-fnid="2">#</span>, а як доглядати лінзу, сказано в <a class="xt" href="jwpub://p/K:1102026102/4">розділі 2, абз. 4</a>.</p>
<p id="p5" data-pid="5" class="sb">Про інше видання: <a href="jwpub://p/K:1102099999/1">«Морські знаки»</a>. Сайт: <a href="https://example.org/lighthouse">example.org</a>.</p>
<video data-video="webpubvid://?pub=zkt&amp;track=1" data-image="zkt_K_cnt_2.jpg"></video>
<p id="p6" data-pid="6" class="sb" onclick="alert(1)">Абзац із картинкою: <img src="jwpub-media://ZKT_K_CNT_2.JPG" alt=""/> і з тією, якої у файлі немає: <img src="jwpub-media://missing.jpg" alt=""/></p>
<script>window.hacked = true</script>
</div></div><div class="groupFootnote"><p>Власний блок приміток видання, який у читалці не потрібен.</p></div>`,
      // A note numbers its paragraphs on its own: "p4" is also a paragraph of the text above.
      notes: { 1: '<div id="footnote1" class="fcc fn-ref"><p id="p4" data-pid="4">Узимку на пів години раніше. Див. <a href="jwpub://b/NWTR/1:1:3-1:1:3" class="b">Буття 1:3</a>.</p></div>', 2: '<p>Не ближче ніж за десять кроків від вежі.</p>' },
    },
    { id: 2, meps: 1102026102, title: 'Розділ 2. Лінза', toc: 'Лінза', html: `<header><h1 id="p1" data-pid="1"><strong>Лінза</strong></h1></header><div class="bodyTxt"><p id="p2" data-pid="2" class="sb">Лінзу протирають щоранку.</p><p id="p3" data-pid="3" class="sb">Спершу сухою тканиною.</p><p id="p4" data-pid="4" class="sb">Потім оцтом, як сказано в <a href="jwpub://p/K:1102026101/4">розділі 1</a>.</p></div>` },
    { id: 3, meps: 1102026103, title: 'Журнал спостережень', html: `<header><h1 id="p1" data-pid="1"><strong>Журнал спостережень</strong></h1></header><div class="bodyTxt">\n${longText(420, 2)}\n</div>` },
    { id: 4, meps: 1102026104, title: 'Порожній документ', html: '' },
  ];
  const rows = {
    Publication: [{ PublicationId: 1, VersionNumber: 1, Type: 1, Title: publication.title, ShortTitle: 'Довідник', Symbol: publication.symbol, UniqueEnglishSymbol: publication.symbol, IssueTagNumber: '0', Year: publication.year, MepsLanguageIndex: publication.language, PublicationType: 'Book' }],
    Document: docs.map((d) => ({ DocumentId: d.id, PublicationId: 1, MepsDocumentId: d.meps, MepsLanguageIndex: publication.language, Class: '13', Type: 0, Title: d.title, TocTitle: d.toc ?? null, Content: d.html ? pack(d.html, c) : null, ParagraphCount: 6, ContentLength: d.html.length })),
    Footnote: docs.flatMap((d) => Object.entries(d.notes ?? {}).map(([index, html]) => ({ DocumentId: d.id, FootnoteIndex: Number(index), Type: 0, Content: pack(html, c) }))),
    Multimedia: [
      { MultimediaId: 1, DataType: 0, MajorType: 1, Width: 600, Height: 400, MimeType: 'image/jpeg', FilePath: 'zkt_K_cnt_1.jpg', CategoryType: 8 },
      { MultimediaId: 2, DataType: 0, MajorType: 1, Width: 300, Height: 200, MimeType: 'image/jpeg', FilePath: 'zkt_K_cnt_2.jpg', CategoryType: 8 },
    ],
    PublicationView: [{ PublicationViewId: 1, Name: 'Publication', Symbol: 'jwpub' }],
    PublicationViewItem: [
      { PublicationViewItemId: 1, PublicationViewId: 1, ParentPublicationViewItemId: -1, Title: publication.title, DefaultDocumentId: -1 },
      { PublicationViewItemId: 2, PublicationViewId: 1, ParentPublicationViewItemId: 1, Title: 'Титульна сторінка', DefaultDocumentId: 0 },
      { PublicationViewItemId: 3, PublicationViewId: 1, ParentPublicationViewItemId: 1, Title: 'ЧАСТИНА 1. Щоденна робота', DefaultDocumentId: -1 },
      { PublicationViewItemId: 4, PublicationViewId: 1, ParentPublicationViewItemId: 3, Title: 'Світло', DefaultDocumentId: 1 },
      { PublicationViewItemId: 5, PublicationViewId: 1, ParentPublicationViewItemId: 3, Title: 'Лінза', DefaultDocumentId: 2 },
      { PublicationViewItemId: 6, PublicationViewId: 1, ParentPublicationViewItemId: 1, Title: 'Журнал спостережень', DefaultDocumentId: null },
      { PublicationViewItemId: 7, PublicationViewId: 1, ParentPublicationViewItemId: 1, Title: 'Порожній документ', DefaultDocumentId: 4 },
    ],
    PublicationViewItemDocument: [{ PublicationViewItemId: 6, DocumentId: 3 }],
    // Many small rows, so that a table spreads over several pages.
    Word: Array.from({ length: 1500 }, (_, i) => ({ WordId: i + 1, Word: `${WORDS[i % WORDS.length]}${i}` })),
  };
  await jwpub(
    'sample.jwpub',
    publication,
    rows,
    {
      'zkt_K_cnt_1.jpg': await drawing('Маяк на мисі', 600, 400, '#2f5d7c'),
      'zkt_K_cnt_2.jpg': await drawing('Лінза', 300, 200, '#7c4a2f'),
      'zkt_K_cvr.jpg': await drawing('Довідник', 600, 800, '#1f3a4d'),
      'zkt_K_t.jpg': await drawing('Довідник', 600, 600, '#1f3a4d'),
      'zkt_K_s.jpg': await drawing('Довідник', 100, 100, '#1f3a4d'),
    },
    // The printed cover is listed after the tiles and is smaller than the widest picture: the reader has to pick it by its type.
    [
      { signature: 'a', fileName: 'zkt_K_s.jpg', type: 't', attribute: 's', width: 100, height: 100 },
      { signature: 'b', fileName: 'zkt_K_t.jpg', type: 't', attribute: 'r', width: 600, height: 600 },
      { signature: 'c', fileName: 'zkt_K_cnt_1.jpg', type: 'lsr', attribute: 'r', width: 1200, height: 600 },
      { signature: 'd', fileName: 'zkt_K_cvr.jpg', type: 'c', attribute: 'r', width: 600, height: 800 },
    ],
  );
}

// ---- A publication with Bible books ----
{
  const publication = { language: 222, symbol: 'zkb', year: 2025, title: 'Збірка притч (тестова)', issue: 20250100 };
  const c = cipher(publication.language, publication.symbol, publication.year, publication.issue);
  const verses = (book, chapter, count, note) =>
    `<p class="sb">${Array.from({ length: count }, (_, i) => {
      const v = i + 1;
      const number = v === 1 ? `<span class="cl">${chapter}</span>` : `<span class="vl">${v}</span>`;
      const mark = note && v === 2 ? `<a class="fn" data-fnid="${note}" href="#">*</a>` : '';
      const cross = v === 3 ? '<a class="m" data-mid="7" href="#">+</a>' : '';
      return `<span id="v${book}-${chapter}-${v}-1" class="v">${number} Вірш ${v} розділу ${chapter} книги ${book}: доглядач засвітив ліхтар${mark}${cross}. <span class="tt">прихована підказка</span></span>`;
    }).join(' ')}</p><p class="sl"><span id="v${book}-${chapter}-${count + 1}-1" class="v"><span class="vl">${count + 1}</span> Останній вірш розділу, набраний як поезія,</span></p><p class="sz"><span id="v${book}-${chapter}-${count + 1}-2" class="v">у два рядки.</span></p>`;
  const rows = {
    Publication: [{ PublicationId: 1, VersionNumber: 1, Type: 1, Title: publication.title, ShortTitle: 'Притчі', Symbol: publication.symbol, UniqueEnglishSymbol: publication.symbol, IssueTagNumber: String(publication.issue), Year: publication.year, MepsLanguageIndex: publication.language, PublicationType: 'Bible' }],
    Document: [
      { DocumentId: 0, PublicationId: 1, MepsDocumentId: 1001070000, Class: '40', Type: 0, Title: 'Вступ', Content: pack('<header><h1 id="p1" data-pid="1">Вступ</h1></header><div class="bodyTxt"><p id="p2" data-pid="2">Починайте з <a href="jwpub://b/NWTR/2:2:3-2:2:3" class="b">Друга книга 2:3</a> або з <a href="jwpub://c/K:1001070102/1:2">першого розділу</a>.</p></div>', c) },
      { DocumentId: 1, PublicationId: 1, MepsDocumentId: 1001070101, Class: '1', Type: 2, Title: 'Перша книга', Content: pack('<p>Текст книги одним документом, який читалка не показує.</p>', c) },
      { DocumentId: 2, PublicationId: 1, MepsDocumentId: 1001070102, Class: '1', Type: 2, Title: 'Друга книга', Content: null },
    ],
    BibleBook: [
      { BibleBookId: 1, PublicationId: 1, BookDocumentId: 1, BookDisplayTitle: 'Перша книга', ChapterDisplayTitle: 'Перша книга' },
      { BibleBookId: 2, PublicationId: 1, BookDocumentId: 2, BookDisplayTitle: 'Друга книга', ChapterDisplayTitle: 'Розділ другої книги' },
    ],
    BibleChapter: [
      { BibleChapterId: 1, BookNumber: 1, ChapterNumber: 1, Content: pack(verses(1, 1, 4, 1), c), FirstVerseId: 1, LastVerseId: 5 },
      { BibleChapterId: 2, BookNumber: 1, ChapterNumber: 2, Content: pack(verses(1, 2, 3, 2), c), FirstVerseId: 6, LastVerseId: 9 },
      { BibleChapterId: 3, BookNumber: 1, ChapterNumber: 3, Content: pack(verses(1, 3, 3, 0), c), FirstVerseId: 10, LastVerseId: 13 },
      { BibleChapterId: 4, BookNumber: 2, ChapterNumber: 1, Content: pack(verses(2, 1, 3, 0), c), FirstVerseId: 14, LastVerseId: 17 },
      { BibleChapterId: 5, BookNumber: 2, ChapterNumber: 2, Content: pack(verses(2, 2, 5, 1), c), FirstVerseId: 18, LastVerseId: 23 },
    ],
    Footnote: [
      { DocumentId: 1, FootnoteIndex: 1, Type: 0, Content: pack('<p>Або «запалив світильник».</p>', c), BibleVerseId: 2 },
      { DocumentId: 1, FootnoteIndex: 2, Type: 0, Content: pack('<p>Примітка до другого розділу першої книги.</p>', c), BibleVerseId: 7 },
      { DocumentId: 2, FootnoteIndex: 1, Type: 0, Content: pack('<p>Примітка до другої книги.</p>', c), BibleVerseId: 19 },
    ],
    // A publication that comes out in issues: the issue's title is the one to show.
    PublicationIssueProperty: [{ PublicationIssuePropertyId: 1, PublicationId: 1, Title: 'Збірка притч, січень 2025', UndatedTitle: 'Збірка притч', CoverTitle: 'Притчі про світло', Symbol: 'zkb25.01', UndatedSymbol: 'zkb' }],
    PublicationView: [{ PublicationViewId: 1, Name: 'Publication', Symbol: 'jwpub' }],
    PublicationViewItem: [
      { PublicationViewItemId: 1, PublicationViewId: 1, ParentPublicationViewItemId: -1, Title: 'Вступ', DefaultDocumentId: 0 },
      { PublicationViewItemId: 2, PublicationViewId: 1, ParentPublicationViewItemId: -1, Title: 'КНИГИ', DefaultDocumentId: -1 },
      { PublicationViewItemId: 3, PublicationViewId: 1, ParentPublicationViewItemId: 2, Title: 'Перша книга', DefaultDocumentId: 1 },
      { PublicationViewItemId: 4, PublicationViewId: 1, ParentPublicationViewItemId: 2, Title: 'Друга книга', DefaultDocumentId: 2 },
    ],
  };
  await jwpub('sample-bible.jwpub', publication, rows, {});
}
