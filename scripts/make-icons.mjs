// Regenerates the PWA icons in public/ from public/logo.svg. Run: npm run icons
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const logo = path.join(pub, 'logo.svg');
const BG = '#2b3a55';

const plain = (size, name) =>
  sharp(logo, { density: 384 }).resize(size, size).png().toFile(path.join(pub, name));

// Maskable / Apple icons: full-bleed background with the logo inside the safe zone.
const padded = async (size, inner, name) => {
  const mark = await sharp(logo, { density: 384 }).resize(inner, inner).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: mark, gravity: 'center' }])
    .png()
    .toFile(path.join(pub, name));
};

await plain(48, 'favicon-48x48.png');
await plain(64, 'pwa-64x64.png');
await plain(192, 'pwa-192x192.png');
await plain(512, 'pwa-512x512.png');
await padded(512, 410, 'maskable-icon-512x512.png');
await padded(180, 160, 'apple-touch-icon-180x180.png');
console.log('icons written to public/');
