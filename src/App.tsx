import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Library } from './components/Library';
import { Reader } from './components/Reader';
import { UpdateToast } from './components/UpdateToast';
import { importBooks } from './lib/library';
import { autoSync } from './lib/sync';
import { useSettings } from './settings';

// The study room is a screen of its own; it is loaded when first opened.
const Study = lazy(() => import('./components/Study').then((m) => ({ default: m.Study })));

const THEME_COLOR = { light: '#ffffff', sepia: '#f8f0dc', dark: '#1c1f25' };

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

interface LaunchParams {
  files?: { getFile(): Promise<File> }[];
}

function bookFromHash(hash: string): string | null {
  const m = /^#\/book\/(.+)$/.exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}

export function App() {
  const settings = useSettings();
  // The screen lives in the URL hash, so Back works as in any app and a reload returns to the same place.
  const [route, setRoute] = useState(() => location.hash);
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const bookId = bookFromHash(route);
  const studying = /^#\/(study|review)\b/.test(route);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[settings.theme]);
  }, [settings.theme]);

  useEffect(() => {
    const onHash = () => setRoute(location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const openBook = useCallback((id: string) => {
    location.hash = `#/book/${encodeURIComponent(id)}`;
  }, []);

  const closeBook = useCallback(() => {
    location.hash = '';
  }, []);

  // Background sync between devices: on start and whenever a book or the study room is left…
  const home = !bookId && !studying;
  useEffect(() => {
    if (home) autoSync(true);
  }, [home]);

  // …every few minutes, when the connection comes back, and when the app is hidden or shown again
  // (on phones that is the moment one device is put down and another picked up).
  useEffect(() => {
    const periodic = () => autoSync();
    const onVisibility = () => autoSync(document.visibilityState === 'hidden');
    const timer = setInterval(periodic, 5 * 60_000);
    window.addEventListener('online', periodic);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', periodic);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as InstallPromptEvent);
    };
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Installed app: files opened from the OS ("Open with…") arrive through the launch queue.
  useEffect(() => {
    const queue = (window as unknown as { launchQueue?: { setConsumer(fn: (p: LaunchParams) => void): void } }).launchQueue;
    queue?.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const files = await Promise.all(params.files.map((handle) => handle.getFile()));
      const { ids } = await importBooks(files);
      if (ids[0]) openBook(ids[0]);
    });
  }, [openBook]);

  let screen: React.ReactNode;
  if (bookId) {
    screen = <Reader key={bookId} bookId={bookId} onExit={closeBook} />;
  } else if (studying) {
    screen = (
      <Suspense
        fallback={
          <div className="reader-state">
            <LoaderCircle size={28} className="spin" />
          </div>
        }
      >
        <Study route={route} onOpenBook={openBook} />
      </Suspense>
    );
  } else {
    screen = (
      <Library
        onOpen={openBook}
        onInstall={
          installEvent
            ? () => {
                void installEvent.prompt();
                setInstallEvent(null);
              }
            : undefined
        }
      />
    );
  }

  return (
    <>
      {screen}
      <UpdateToast />
    </>
  );
}
