// Keeps the installed app up to date without the reader doing anything: looks for a new version
// regularly, downloads it in the background and switches to it at a moment when nothing is lost.
import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';
import { isWorking, onIdle } from './busy';
import { isTypingTarget } from './utils';

/** How often an open app asks the server whether there is a newer version. */
const CHECK_EVERY = 15 * 60_000;
const UPDATED_FLAG = 'zakladka:justUpdated';

/** `ready`: downloaded and waiting for a good moment; `applied`: this page has just been updated. */
export type UpdateState = 'none' | 'ready' | 'applied';

let state: UpdateState = 'none';
let apply: ((reload?: boolean) => Promise<void>) | null = null;
let registration: ServiceWorkerRegistration | undefined;
const listeners = new Set<() => void>();

function setState(next: UpdateState) {
  state = next;
  listeners.forEach((l) => l());
}

/** A book or a review session is on screen: reloading now would blink in the middle of it. */
const inTheMiddle = () => /^#\/(book|review)\b/.test(location.hash);

function applyWhenSafe() {
  if (state !== 'ready' || isWorking() || isTypingTarget(document.activeElement)) return;
  // Switch while the app is in the background, or on a screen where a reload costs nothing.
  if (document.visibilityState === 'hidden' || !inTheMiddle()) applyUpdate();
}

/** Switches to the new version now: the page reloads and returns to the same place. */
export function applyUpdate(): void {
  if (!apply) return;
  try {
    sessionStorage.setItem(UPDATED_FLAG, '1');
  } catch {
    // Without storage the "updated" notice is simply not shown.
  }
  void apply(true);
}

function check() {
  if (navigator.onLine) void registration?.update().catch(() => {});
}

/**
 * Asked for by the reader: looks for a newer version now and, when there is one, waits for it to
 * download. Resolves to what was found.
 */
export async function checkForUpdate(): Promise<'ready' | 'latest' | 'offline' | 'unsupported'> {
  if (!registration) return 'unsupported';
  if (!navigator.onLine) return 'offline';
  try {
    await registration.update();
  } catch {
    return 'offline';
  }
  // A new version, if any, is now downloading; it announces itself through onNeedRefresh.
  for (let i = 0; i < 120 && state !== 'ready' && (registration.installing || registration.waiting); i++) await new Promise((done) => setTimeout(done, 500));
  if (state !== 'ready' && registration.waiting) setState('ready');
  return state === 'ready' ? 'ready' : 'latest';
}

export function startAutoUpdate(): void {
  try {
    if (sessionStorage.getItem(UPDATED_FLAG)) {
      sessionStorage.removeItem(UPDATED_FLAG);
      state = 'applied';
      setTimeout(() => state === 'applied' && setState('none'), 4000);
    }
  } catch {
    // Ignore.
  }

  apply = registerSW({
    immediate: true,
    onRegisteredSW(_url, r) {
      registration = r;
      // A version downloaded earlier and never switched to (the app was closed first) counts as ready too.
      setTimeout(() => {
        if (state === 'none' && r?.waiting && navigator.serviceWorker.controller) {
          setState('ready');
          applyWhenSafe();
        }
      }, 3000);
    },
    // The new version has been downloaded and is waiting.
    onNeedRefresh() {
      setState('ready');
      applyWhenSafe();
    },
  });

  onIdle(applyWhenSafe);
  setInterval(check, CHECK_EVERY);
  window.addEventListener('online', check);
  window.addEventListener('hashchange', () => setTimeout(applyWhenSafe, 300));
  window.addEventListener('focusout', () => setTimeout(applyWhenSafe, 500));
  document.addEventListener('visibilitychange', () => {
    // Coming back to the app is when a phone has most likely missed an update;
    // leaving it is the moment to switch without anyone noticing.
    if (document.visibilityState === 'visible') check();
    else applyWhenSafe();
  });
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
