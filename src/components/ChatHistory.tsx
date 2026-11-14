import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Search, Trash2, X } from 'lucide-react';
import { getAgent } from '../ai/agents';
import { db, deleteChat } from '../db';
import { LIBRARY_CHAT, searchThreads, threadTitle } from '../lib/chats';
import { cx, pluralUk, truncate } from '../lib/utils';
import type { ChatThread } from '../types';

interface Props {
  /** The open book: its conversations are shown first, with a switch to those of every book. */
  bookId?: string;
  /** Given when the search box belongs to whoever shows this list. */
  query?: string;
  currentThreadId?: string | null;
  onOpen(thread: ChatThread): void;
}

const dateOf = (time: number) => {
  const d = new Date(time);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};

/** Saved conversations with the agents — of one book or of the whole library — with search through what was said. */
export function ChatHistory({ bookId, query, currentThreadId, onOpen }: Props) {
  const threads = useLiveQuery(() => db.chats.toArray(), []);
  const books = useLiveQuery(() => db.books.toArray(), []);
  const [everywhere, setEverywhere] = useState(!bookId);
  const [own, setOwn] = useState('');
  const text = query ?? own;

  const matches = useMemo(() => {
    const scope = (threads ?? []).filter((t) => everywhere || t.bookId === bookId);
    return searchThreads(scope, text);
  }, [threads, everywhere, bookId, text]);
  const titleOfBook = (id: string) => (id === LIBRARY_CHAT ? 'у бібліотеці' : (books?.find((b) => b.id === id)?.title ?? 'книгу видалено'));

  return (
    <div className="chat-history">
      {query === undefined && (
        <form className="search-form" onSubmit={(e) => e.preventDefault()}>
          <Search size={16} className="search-icon" />
          <input value={own} onChange={(e) => setOwn(e.target.value)} placeholder="Пошук у розмовах…" aria-label="Пошук у розмовах" enterKeyHint="search" />
          {own && (
            <button type="button" className="icon-btn" onClick={() => setOwn('')} title="Очистити">
              <X size={16} />
            </button>
          )}
        </form>
      )}
      {bookId && (
        <div className="segmented wide">
          <button className={cx(!everywhere && 'active')} onClick={() => setEverywhere(false)}>
            {bookId === LIBRARY_CHAT ? 'У бібліотеці' : 'Ця книга'}
          </button>
          <button className={cx(everywhere && 'active')} onClick={() => setEverywhere(true)}>
            Усі розмови
          </button>
        </div>
      )}
      {threads && (
        <p className="panel-meta">
          {matches.length
            ? `${matches.length} ${pluralUk(matches.length, 'розмова', 'розмови', 'розмов')}`
            : text.trim()
              ? `У розмовах нічого не знайдено за запитом «${truncate(text.trim(), 40)}».`
              : 'Розмов ще немає. Кожна нова розмова з агентом зберігається тут.'}
        </p>
      )}
      <ul>
        {matches.map(({ thread, snippet }) => {
          const agent = getAgent(thread.agentId);
          return (
            <li key={thread.id} className="chat-row">
              <button className={cx('hit', thread.id === currentThreadId && 'active')} onClick={() => onOpen(thread)}>
                <span className="hit-label">
                  <agent.icon size={13} /> {agent.name}
                  {everywhere && ` · ${truncate(titleOfBook(thread.bookId), 36)}`}
                  <span className="score">{dateOf(thread.updatedAt)}</span>
                </span>
                <span className="hit-text">
                  <strong>{threadTitle(thread)}</strong>
                </span>
                {snippet && (
                  <span className="hit-text">
                    {snippet.pre}
                    <mark>{snippet.match}</mark>
                    {snippet.post}
                  </span>
                )}
              </button>
              <button
                className="icon-btn"
                title="Видалити розмову"
                aria-label="Видалити розмову"
                onClick={() => confirm(`Видалити розмову «${truncate(threadTitle(thread), 50)}»?`) && void deleteChat(thread.id)}
              >
                <Trash2 size={15} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
