/**
 * What a book should do when it is opened from somewhere else in the app — a search result in the
 * library, a study card, a step of a study topic — instead of simply resuming where the reader
 * left it. Kept in memory only: it is used once, by the reader that opens next.
 */
export interface Jump {
  bookId: string;
  /** Page (PDF/DjVu) or chapter (EPUB) to go to. */
  unit?: number;
  /** Exact search: the words to highlight, and which occurrence in the unit was picked. */
  query?: string;
  matchIndex?: number;
  /** Search by meaning, or a card's source: the passage to find on that page. */
  passage?: string;
  /** Open the AI panel on this saved conversation. */
  thread?: string;
  /** Open the AI panel and put this request to the given agent. */
  ask?: { agentId: string; text: string };
}

let pending: Jump | null = null;

export function setJump(jump: Jump): void {
  pending = jump;
}

/** Returns the jump meant for this book, if any, and forgets it. */
export function takeJump(bookId: string): Jump | null {
  const jump = pending?.bookId === bookId ? pending : null;
  pending = null;
  return jump;
}
