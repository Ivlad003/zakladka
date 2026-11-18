import { useMemo, useState } from 'react';
import { BookOpen, LoaderCircle, X } from 'lucide-react';
import type { AgentContext } from '../ai/tools';
import type { Engine } from '../engines/types';
import { LIBRARY_CHAT } from '../lib/chats';
import { setJump } from '../lib/jump';
import { unitLabel } from '../lib/library-search';
import { studyApiFor } from '../lib/study';
import { truncate } from '../lib/utils';
import type { BookRecord } from '../types';
import { AiPanel } from './AiPanel';

interface Props {
  /** A saved conversation to show. */
  thread: string | null;
  onOpenBook(bookId: string): void;
  onOpenSettings(): void;
  onClose(): void;
}

// The panel and the agents were written around an open book. In the library there is none, so
// they get a stand-in: conversations are filed under it, and no tool that reads a book is offered.
const NO_BOOK: BookRecord = {
  id: LIBRARY_CHAT,
  title: 'Бібліотека',
  author: '',
  format: 'epub',
  size: 0,
  fileName: '',
  addedAt: 0,
  lastOpenedAt: 0,
  progress: 0,
  position: null,
  unitCount: 0,
  cover: null,
};

const NO_ENGINE = {
  format: 'epub',
  kind: 'epub',
  unitCount: 0,
  metadata: {},
  getToc: async () => [],
  getUnitText: async () => '',
  search: async () => [],
  makeCover: async () => null,
  destroy() {},
} as unknown as Engine;

const nothing = () => {};

/**
 * The conversation with the agents that work with the whole library (the agent page): a librarian
 * that searches every book and can add one made from a GitHub repository, and the settings helper.
 */
export function LibraryAssistant({ thread, onOpenBook, onOpenSettings, onClose }: Props) {
  // What the librarian proposes to open; the reader decides.
  const [offer, setOffer] = useState<{ book: BookRecord; unit?: number; passage?: string } | null>(null);
  // A book being written at the agent's request: minutes of work the reader should see moving.
  const [work, setWork] = useState<{ step: string; done: number; total: number } | null>(null);

  const ctx = useMemo<AgentContext>(
    () => ({
      book: NO_BOOK,
      engine: NO_ENGINE,
      noBook: true,
      getCurrentUnit: () => 0,
      getChapterTitle: () => undefined,
      goToUnit: nothing,
      listAnnotations: async () => [],
      createNote: async () => {},
      semanticSearch: async () => null,
      study: studyApiFor(NO_BOOK),
      unitLabel: () => '',
      offerBook: (book, unit, passage) => setOffer({ book, unit, passage }),
      showWork: setWork,
    }),
    [],
  );

  const open = () => {
    if (!offer) return;
    if (offer.unit !== undefined) setJump({ bookId: offer.book.id, unit: offer.unit, passage: offer.passage });
    onOpenBook(offer.book.id);
  };

  return (
    <div className="agent-chat">
      {offer && (
        <div className="ai-offer">
          <button className="btn primary" onClick={open}>
            <BookOpen size={16} />
            <span>
              Відкрити «{truncate(offer.book.title, 40)}»{offer.unit !== undefined && ` — ${unitLabel(offer.book, null, offer.unit)}`}
            </span>
          </button>
          <button className="icon-btn" onClick={() => setOffer(null)} title="Сховати" aria-label="Сховати">
            <X size={16} />
          </button>
        </div>
      )}
      {work && (
        <div className="ai-work" role="status">
          <span>
            <LoaderCircle size={14} className="spin" /> {work.step}
          </span>
          <div className="search-progress">
            <div className="bar" style={{ width: `${Math.round((Math.min(work.done, work.total) / Math.max(1, work.total)) * 100)}%` }} />
          </div>
        </div>
      )}
      <AiPanel ctx={ctx} request={null} onRequestHandled={nothing} quote={null} onQuoteClear={nothing} openThread={thread} onOpenSettings={onOpenSettings} onClose={onClose} />
    </div>
  );
}
