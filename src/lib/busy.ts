// Long jobs that a page reload would destroy: recognising text, building an index, an answer being
// written by a model, importing, syncing. The updater waits for them before switching versions.
let holds = 0;
const idleListeners = new Set<() => void>();

/** Marks the start of such a job; call the returned function when it is over. */
export function holdWork(): () => void {
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    // A moment's grace: jobs often follow one another (a sync right after an import).
    if (holds === 0) setTimeout(() => holds === 0 && idleListeners.forEach((fn) => fn()), 1500);
  };
}

export function duringWork<T>(work: Promise<T>): Promise<T> {
  const release = holdWork();
  return work.finally(release);
}

export const isWorking = (): boolean => holds > 0;

export function onIdle(fn: () => void): void {
  idleListeners.add(fn);
}
