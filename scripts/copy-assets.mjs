// Copies runtime assets of PDF.js (character maps, standard fonts) and Tesseract (OCR worker and
// WebAssembly cores) into public/, so the app serves them itself and they work offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'pdfjs-dist');
const dest = path.join(root, 'public', 'pdfjs');

for (const dir of ['cmaps', 'standard_fonts']) {
  const from = path.join(src, dir);
  const to = path.join(dest, dir);
  if (!fs.existsSync(from)) {
    console.error(`copy-assets: ${from} not found — run npm install first`);
    process.exit(1);
  }
  if (fs.existsSync(to)) continue;
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`copy-assets: ${dir} -> public/pdfjs/${dir}`);
}

// Tesseract: the worker script and the LSTM-only cores (one per CPU feature level; the worker picks one).
const tesseract = path.join(root, 'public', 'tesseract');
const ocrFiles = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map((f) => [`tesseract.js-core/${f}`, f]),
];
fs.mkdirSync(tesseract, { recursive: true });
for (const [from, name] of ocrFiles) {
  const source = path.join(root, 'node_modules', from);
  const target = path.join(tesseract, name);
  if (!fs.existsSync(source)) {
    console.error(`copy-assets: ${source} not found — run npm install first`);
    process.exit(1);
  }
  if (fs.existsSync(target) && fs.statSync(target).size === fs.statSync(source).size) continue;
  fs.copyFileSync(source, target);
  console.log(`copy-assets: ${name} -> public/tesseract/`);
}
