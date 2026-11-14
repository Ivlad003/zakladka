// Test books in Kindle formats, written from the published description of the format:
//   dev-samples/sample.mobi   MOBI 6: PalmDOC-compressed UTF-8 text with page breaks, a table of
//                             contents that links by byte offset, a picture, a cover, and the
//                             trailing bytes real files carry at the end of every text record
//   dev-samples/sample.azw3   KF8: uncompressed, the text cut into skeletons and fragments,
//                             followed by a stylesheet flow
// They exercise the reader's converter; they are not a substitute for trying real files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev-samples');
const enc = new TextEncoder();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8Dwn4GBgQEMAA79Af+hVcHVAAAAAElFTkSuQmCC', 'base64');
const u16 = (n) => Buffer.from([(n >> 8) & 255, n & 255]);
const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** PalmDOC compression: copies from the last 2 KB, "space + letter" pairs, literals. */
function palmDoc(data) {
  const res = [];
  let i = 0;
  while (i < data.length) {
    // The longest earlier match of 3–10 bytes within 2047 bytes.
    let best = 0;
    let distance = 0;
    if (i + 3 <= data.length) {
      for (let j = Math.max(0, i - 2047); j < i; j++) {
        let n = 0;
        while (n < 10 && i + n < data.length && data[j + n] === data[i + n]) n++;
        if (n > best) {
          best = n;
          distance = i - j;
        }
      }
    }
    if (best >= 3) {
      const pair = 0x8000 | (distance << 3) | (best - 3);
      res.push(pair >> 8, pair & 255);
      i += best;
    } else if (data[i] === 0x20 && i + 1 < data.length && data[i + 1] >= 0x40 && data[i + 1] <= 0x7f) {
      res.push(data[i + 1] ^ 0x80);
      i += 2;
    } else if (data[i] === 0 || (data[i] >= 9 && data[i] <= 0x7f)) {
      res.push(data[i++]);
    } else {
      // Bytes that would read as commands travel as a counted run.
      let n = 1;
      while (n < 8 && i + n < data.length && !(data[i + n] === 0 || (data[i + n] >= 9 && data[i + n] <= 0x7f))) n++;
      res.push(n, ...data.subarray(i, i + n));
      i += n;
    }
  }
  return Buffer.from(res);
}

function pdb(name, records) {
  const header = Buffer.alloc(78);
  header.write(name.slice(0, 31), 0, 'latin1');
  header.write('BOOKMOBI', 60, 'latin1');
  header.writeUInt16BE(records.length, 76);
  const list = Buffer.alloc(records.length * 8 + 2);
  let at = header.length + list.length;
  records.forEach((r, i) => {
    list.writeUInt32BE(at, i * 8);
    list.writeUInt32BE(i * 2, i * 8 + 4);
    at += r.length;
  });
  return Buffer.concat([header, list, ...records]);
}

function record0({ compression, textLength, textRecords, version, firstPicture, extraFlags, title, exth, fdst }) {
  const mobi = Buffer.alloc(248, 0);
  mobi.write('MOBI', 0, 'latin1');
  mobi.writeUInt32BE(248, 4); // header length
  mobi.writeUInt32BE(2, 8); // a book
  mobi.writeUInt32BE(65001, 12); // UTF-8
  mobi.writeUInt32BE(version, 20);
  mobi.writeUInt32BE(firstPicture, 92);
  mobi.writeUInt32BE(0x40, 112); // has EXTH
  mobi.writeUInt32BE(fdst ?? 0xffffffff, 176);
  mobi.writeUInt16BE(extraFlags, 226);
  const items = exth.map(([type, data]) => Buffer.concat([u32(type), u32(8 + data.length), data]));
  let extra = Buffer.concat([Buffer.from('EXTH'), u32(12 + items.reduce((n, b) => n + b.length, 0)), u32(items.length), ...items]);
  if (extra.length % 4) extra = Buffer.concat([extra, Buffer.alloc(4 - (extra.length % 4))]);
  const name = Buffer.from(title, 'utf8');
  mobi.writeUInt32BE(16 + mobi.length + extra.length, 68); // full name offset
  mobi.writeUInt32BE(name.length, 72);
  const palm = Buffer.concat([u16(compression), u16(0), u32(textLength), u16(textRecords), u16(4096), u16(0), u16(0)]);
  return Buffer.concat([palm, mobi, extra, name, Buffer.alloc(4)]);
}

/** Cuts text into 4096-byte records the way real files do, with the trailing bytes asked for by `flags`. */
function textRecords(text, compress, flags) {
  const records = [];
  for (let at = 0; at < text.length; at += 4096) {
    const piece = text.subarray(at, Math.min(text.length, at + 4096));
    const parts = [compress ? palmDoc(piece) : Buffer.from(piece)];
    if (flags & 1) {
      // The rest of a character cut by the record boundary, then how many bytes that was.
      let more = 0;
      while (at + 4096 + more < text.length && (text[at + 4096 + more] & 0xc0) === 0x80) more++;
      parts.push(Buffer.from(text.subarray(at + 4096, at + 4096 + more)), Buffer.from([more]));
    }
    if (flags & 2) parts.push(Buffer.from([0xaa, 0xbb, 0x83])); // an index entry: two bytes and its own size (3)
    records.push(Buffer.concat(parts));
  }
  return records;
}

const filler = (n, what) => Array.from({ length: n }, (_, i) => `<p width="1.5em">Абзац ${i + 1}. ${what}</p>`).join('\n');

// ---------- MOBI 6 ----------
{
  const chapters = [
    ['Розділ 1. Причал', `<p>Пором прийшов уночі. На причалі стояв <b>ліхтар</b>, і слово «баклан» у цій книзі є лише тут.</p><p><img recindex="00002" alt="причал"></p>${filler(40, 'Туман лежав над водою, і дошки причалу рипіли під кожним кроком.')}`],
    ['Розділ 2. Крамниця', `<p height="1em">У крамниці пахло смолою та мотузками. <a filepos=@@1@@>Повернутися до причалу</a>.</p>${filler(40, 'Крамар рахував монети й поглядав на барометр, що падав від самого ранку.')}`],
    ['Розділ 3. Шторм', `<p>Шторм почався опівдні & тривав до ночі.</p>${filler(40, 'Хвилі перекочувалися через мол, а чайки ховалися під дахом рибного складу.')}`],
  ];
  const build = (pos) => {
    const toc = `<h2>Зміст</h2>${chapters.map(([name], i) => `<p><a filepos=${String(pos[i]).padStart(10, '0')}>${name}</a></p>`).join('')}`;
    const body = chapters.map(([name, html], i) => `<mbp:pagebreak/><h1>${name}</h1>${html.replace('@@1@@', String(pos[0]).padStart(10, '0'))}`);
    const head = `<html><head><guide><reference type="toc" title="Зміст" filepos=${String(pos[3]).padStart(10, '0')} /></guide></head><body><h1>Пором до острова</h1><p>Тестова книга у форматі MOBI.</p><mbp:pagebreak/>`;
    return { head, toc, body, text: `${head}${toc}${body.join('')}</body></html>` };
  };
  // Offsets are byte positions in the finished text, so the text is laid out twice.
  let pos = [0, 0, 0, 0];
  for (let round = 0; round < 2; round++) {
    const { head, toc, body } = build(pos);
    const next = [];
    let at = enc.encode(head + toc).length;
    for (const part of body) {
      next.push(at + enc.encode('<mbp:pagebreak/>').length);
      at += enc.encode(part).length;
    }
    next.push(enc.encode(head).length);
    pos = next;
  }
  const text = enc.encode(build(pos).text);
  const flags = 3;
  const texts = textRecords(text, true, flags);
  const firstPicture = 1 + texts.length;
  const file = pdb('Porom_do_ostrova', [
    record0({
      compression: 2,
      textLength: text.length,
      textRecords: texts.length,
      version: 6,
      firstPicture,
      extraFlags: flags,
      title: 'Пором до острова',
      exth: [
        [100, Buffer.from('Марко Тестовий', 'utf8')],
        [524, Buffer.from('uk', 'utf8')],
        [201, u32(0)],
      ],
    }),
    ...texts,
    PNG, // picture 1: the cover
    PNG, // picture 2: in chapter 1
    Buffer.from('FLIS\0\0\0\x08', 'latin1'),
    Buffer.from([0xe9, 0x8e, 0x0d, 0x0a]),
  ]);
  fs.writeFileSync(path.join(out, 'sample.mobi'), file);
  console.log('sample.mobi', file.length, 'bytes;', texts.length, 'text records; compressed to', Math.round((texts.reduce((n, r) => n + r.length, 0) / text.length) * 100) + '%');
}

// ---------- KF8 ----------
{
  const skeleton = (title) => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><link rel="stylesheet" type="text/css" href="kindle:flow:0001?mime=text/css"/></head><body aid="0"></body></html>`;
  const flow0 = [
    skeleton('Маяк'),
    `<h1>Глава перша. Маяк</h1><p>Наглядач піднявся на вежу. <a href="kindle:pos:fid:0001:off:0000000000">Далі</a></p><p><img src="kindle:embed:0002?mime=image/png" alt=""/></p>${filler(12, 'Лампа оберталася повільно, і промінь ковзав по воді.')}`,
    skeleton('Берег'),
    `<h1>Глава друга. Берег</h1><p>На березі сушилися сіті.</p>${filler(12, 'Рибалки лагодили човни й сперечалися про погоду.')}`,
  ].join('');
  const css = 'h1 { color: navy } p { margin: 0 }';
  const first = enc.encode(flow0);
  const text = Buffer.concat([Buffer.from(first), Buffer.from(css, 'utf8')]);
  const texts = textRecords(text, false, 0);
  const firstPicture = 1 + texts.length + 1;
  const fdst = Buffer.concat([Buffer.from('FDST'), u32(12), u32(2), u32(0), u32(first.length), u32(first.length), u32(text.length)]);
  const file = pdb('Mayak_KF8', [
    record0({
      compression: 1,
      textLength: text.length,
      textRecords: texts.length,
      version: 8,
      firstPicture,
      extraFlags: 0,
      title: 'Маяк і берег',
      exth: [
        [100, Buffer.from('Ірина Тестова', 'utf8')],
        [201, u32(0)],
      ],
      fdst: 1 + texts.length,
    }),
    ...texts,
    fdst,
    PNG,
    PNG,
  ]);
  fs.writeFileSync(path.join(out, 'sample.azw3'), file);
  console.log('sample.azw3', file.length, 'bytes');
}
