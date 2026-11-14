import { createRoot } from 'react-dom/client';
import { App } from './App';
import { trackVisibleHeight } from './lib/gestures';
import { importBooks } from './lib/library';
import { installSubtleShim } from './lib/subtle-shim';
import { applyFit, storedFit } from './lib/fsrs-fit';
import { getSettings } from './settings';
import { startAutoUpdate } from './lib/update';
import './styles.css';

installSubtleShim();
// Safari on iPhone is known not to deliver touches to a frame unless the page around it listens for
// touches too. The book's page is such a frame, so the app always has a (do-nothing) listener.
for (const type of ['touchstart', 'touchmove', 'touchend'] as const) document.addEventListener(type, () => {}, { passive: true });
trackVisibleHeight();

createRoot(document.getElementById('root')!).render(<App />);

// Service worker: caches the app shell so the reader and the library work offline, and keeps the
// app up to date on its own.
// The schedule fitted to this reader last time applies from the first card.
applyFit(storedFit(), getSettings().studyPersonal);
startAutoUpdate();

if (import.meta.env.DEV) {
  // Development helper: import a test book served by the dev server, e.g.
  //   await __zakladka.importUrl('/__samples/sample.epub')
  (window as unknown as Record<string, unknown>).__zakladka = {
    async importUrl(url: string) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const name = decodeURIComponent(url.split('/').pop() ?? 'book');
      return importBooks([new File([await res.blob()], name)]);
    },
  };
}
