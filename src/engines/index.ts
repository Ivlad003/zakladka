import type { BookFormat } from '../types';
import type { Engine } from './types';

/** Opens a book. Each format's engine is loaded on demand to keep the initial bundle small. */
export async function openEngine(format: BookFormat, data: ArrayBuffer): Promise<Engine> {
  switch (format) {
    case 'pdf':
      return (await import('./pdf')).PdfEngine.open(data);
    case 'djvu':
      return (await import('./djvu')).DjvuEngine.open(data);
    case 'epub':
      return (await import('./epub')).EpubEngine.open(data);
  }
}

export async function detectFormat(file: File): Promise<BookFormat | null> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const ascii = String.fromCharCode(...head);
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (ascii.startsWith('AT&TFORM')) return 'djvu';
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ascii.startsWith('PK') && (ext === 'epub' || ascii.includes('application/epub+zip'))) return 'epub';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'djvu' || ext === 'djv') return 'djvu';
  if (ext === 'epub') return 'epub';
  return null;
}
