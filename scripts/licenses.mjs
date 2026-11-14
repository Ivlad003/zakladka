// After a build: the licences of the libraries that end up in the app (everything npm installs that
// is not a development tool), gathered into dist/third-party-licenses.txt, as their licences ask
// when the code is passed on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const NAMES = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

const sections = [];
for (const [where, info] of Object.entries(lock.packages ?? {})) {
  if (!where.startsWith('node_modules/') || info.dev) continue;
  const dir = path.join(root, where);
  if (!fs.existsSync(dir)) continue;
  const name = where.slice(where.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const texts = fs
    .readdirSync(dir)
    .filter((f) => NAMES.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim());
  sections.push(`${name}@${info.version} — ${info.license ?? 'see below'}\n${'-'.repeat(60)}\n${texts.join('\n\n') || '(no licence file in the package; licence as declared above)'}`);
}
sections.sort();
const header = `Third-party software in Закладка (${sections.length} packages)\n${'='.repeat(60)}\n\n`;
fs.writeFileSync(path.join(root, 'dist', 'third-party-licenses.txt'), header + sections.join('\n\n\n') + '\n');
console.log(`licenses: ${sections.length} packages -> dist/third-party-licenses.txt`);
