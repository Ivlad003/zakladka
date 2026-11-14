// Saved conversations with the agents: what they are listed under, and searching through them.
import type { ChatThread, UiMessage } from '../types';
import { truncate } from './utils';

/** What conversations held in the library, with no book open, are filed under in place of a book id. */
export const LIBRARY_CHAT = 'library';

/** The words of a message, without the tool-call lines. */
export const messageText = (m: UiMessage): string =>
  m.role === 'user'
    ? m.text
    : m.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('\n');

export function threadTitle(thread: Pick<ChatThread, 'title' | 'ui'>): string {
  if (thread.title) return thread.title;
  const first = thread.ui.find((m) => m.role === 'user');
  return first ? truncate(messageText(first).replace(/\s+/g, ' '), 70) : 'Розмова';
}

export interface ThreadMatch {
  thread: ChatThread;
  /** Where in the conversation the query was found; null when only the title matched or there is no query. */
  snippet: { pre: string; match: string; post: string } | null;
}

/** Conversations that contain the query, newest first; all of them when the query is empty. */
export function searchThreads(threads: ChatThread[], query: string): ThreadMatch[] {
  const q = query.trim().toLocaleLowerCase();
  const sorted = threads.filter((t) => t.ui.length).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!q) return sorted.map((thread) => ({ thread, snippet: null }));
  const out: ThreadMatch[] = [];
  for (const thread of sorted) {
    let snippet: ThreadMatch['snippet'] = null;
    for (const message of thread.ui) {
      const text = messageText(message);
      const at = text.toLocaleLowerCase().indexOf(q);
      if (at < 0) continue;
      const tidy = (s: string) => s.replace(/\s+/g, ' ');
      snippet = { pre: (at > 50 ? '…' : '') + tidy(text.slice(Math.max(0, at - 50), at)), match: text.slice(at, at + q.length), post: `${tidy(text.slice(at + q.length, at + q.length + 90))}…` };
      break;
    }
    if (snippet || threadTitle(thread).toLocaleLowerCase().includes(q)) out.push({ thread, snippet });
  }
  return out;
}
