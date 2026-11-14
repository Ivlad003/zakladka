// Test books in FB2: a UTF-8 one with parts, chapters, notes, verse and a picture, and the same
// text in windows-1251 inside a zip (how such files usually travel).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(project, 'package.json'));
const JSZip = require('jszip');

// A 2×2 red PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8Dwn4GBgQEMAA79Af+hVcHVAAAAAElFTkSuQmCC';
const filler = (n) => Array.from({ length: n }, (_, i) => `<p>Абзац ${i + 1}. Хвилі билися об скелі, і доглядач рахував їх, щоб не заснути до ранку.</p>`).join('\n');

const xml = (encoding) => `<?xml version="1.0" encoding="${encoding}"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
<title-info>
<genre>prose_contemporary</genre>
<author><first-name>Олена</first-name><last-name>Тестова</last-name></author>
<book-title>Острів і маяк</book-title>
<annotation><p>Коротка повість для перевірки формату FB2: частини, розділи, примітки, вірш і малюнок.</p></annotation>
<coverpage><image l:href="#cover.png"/></coverpage>
<lang>uk</lang>
<sequence name="Морські історії" number="2"/>
</title-info>
<document-info><author><nickname>test</nickname></author><date>2026</date><id>test-fb2-1</id><version>1.0</version></document-info>
</description>
<body>
<title><p>Острів і маяк</p></title>
<epigraph><p>Море не питає, хто ти.</p><text-author>Невідомий моряк</text-author></epigraph>
<section>
<title><p>Частина перша</p><p>Прибуття</p></title>
<section id="ch1">
<title><p>Розділ 1. Човен</p></title>
<p>Човен причалив удосвіта. Доглядач ніс <emphasis>ліхтар</emphasis> і <strong>журнал</strong>, у якому слово «кормóран» трапляється лише раз<a l:href="#n1" type="note">[1]</a>.</p>
<empty-line/>
<p>На березі його ніхто не чекав.</p>
${filler(14)}
</section>
<section id="ch2">
<title><p>Розділ 2. Сходи</p></title>
<p>Сходів було сто сорок сім. Він порахував їх двічі & записав.</p>
<subtitle>* * *</subtitle>
<poem><title><p>Пісня доглядача</p></title><stanza><v>Світи, мій вогню, над водою,</v><v>веди кораблі до спокою.</v></stanza><text-author>Народна</text-author></poem>
<image l:href="#pic1.png"/>
<cite><p>«Лампу запалювати за пів години до заходу сонця».</p><text-author>Інструкція</text-author></cite>
${filler(10)}
</section>
</section>
<section>
<title><p>Частина друга</p></title>
<section>
<title><p>Розділ 3. Буря</p></title>
<p>Буря прийшла з півночі. Дивись також <a l:href="#ch1">перший розділ</a>.</p>
${filler(8)}
</section>
</section>
</body>
<body name="notes">
<title><p>Примітки</p></title>
<section id="n1"><title><p>1</p></title><p>Кормóран — морський птах; тут слово вжито один раз навмисно.</p></section>
</body>
<binary id="cover.png" content-type="image/png">${PNG}</binary>
<binary id="pic1.png" content-type="image/png">${PNG}</binary>
</FictionBook>`;

const CP1251 = { 'і': 0xb3, 'І': 0xb2, 'ї': 0xbf, 'Ї': 0xaf, 'є': 0xba, 'Є': 0xaa, 'ґ': 0xb4, 'Ґ': 0xa5, '«': 0xab, '»': 0xbb, '—': 0x97, '№': 0xb9, '’': 0x92, 'ё': 0xb8, 'Ё': 0xa8 };
const toCp1251 = (text) =>
  Uint8Array.from([...text.normalize('NFC').replace(/́/g, '')].map((ch) => {
    const code = ch.codePointAt(0);
    if (code < 0x80) return code;
    if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
    if (CP1251[ch] !== undefined) return CP1251[ch];
    return 0x3f;
  }));

fs.writeFileSync(path.join(project, 'dev-samples', 'sample.fb2'), xml('utf-8'));
const zip = new JSZip();
zip.file('ostriv-1251.fb2', toCp1251(xml('windows-1251')));
fs.writeFileSync(path.join(project, 'dev-samples', 'sample-1251.fb2.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('written', fs.statSync(path.join(project, 'dev-samples', 'sample.fb2')).size, fs.statSync(path.join(project, 'dev-samples', 'sample-1251.fb2.zip')).size);
