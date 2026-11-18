import { lazy, Suspense, useState } from 'react';
import { ArrowLeft, GitBranch } from 'lucide-react';
import { LIBRARY_CHAT } from '../lib/chats';
import { takeJump } from '../lib/jump';
import { AiSettings } from './AiSettings';
import { LibraryAssistant } from './LibraryAssistant';

const RepoBookDialog = lazy(() => import('./RepoBookDialog').then((m) => ({ default: m.RepoBookDialog })));

interface Props {
  onOpenBook(bookId: string): void;
}

/**
 * The agent's page: a conversation about the whole library — what is in the books, where something
 * is said, how the app is set up — and the place to make a book out of a GitHub repository, either
 * by asking the agent for it or with the form behind the button.
 */
export function AgentPage({ onOpenBook }: Props) {
  // A saved conversation may be asked for from a book's history or from the library's search.
  const [thread] = useState(() => takeJump(LIBRARY_CHAT)?.thread ?? null);
  const [aiSettings, setAiSettings] = useState(false);
  const [repoBook, setRepoBook] = useState(false);
  const leave = () => (location.hash = '');

  return (
    <div className="library agent-page">
      <header className="library-bar">
        <button className="icon-btn" onClick={leave} title="До бібліотеки" aria-label="До бібліотеки">
          <ArrowLeft size={20} />
        </button>
        <div className="brand">
          <div>
            <strong>Агент</strong>
            <small className="muted">розмова про всю бібліотеку й книжки з GitHub</small>
          </div>
        </div>
        <span className="spacer" />
        <button className="btn" onClick={() => setRepoBook(true)} title="Книжка або журнал із репозиторію, pull request чи різниці між гілками">
          <GitBranch size={16} /> Книжка з GitHub
        </button>
      </header>
      <LibraryAssistant thread={thread} onOpenBook={onOpenBook} onOpenSettings={() => setAiSettings(true)} onClose={leave} />
      {repoBook && (
        <Suspense fallback={null}>
          <RepoBookDialog onOpenBook={onOpenBook} onOpenAiSettings={() => setAiSettings(true)} onClose={() => setRepoBook(false)} />
        </Suspense>
      )}
      {aiSettings && <AiSettings onClose={() => setAiSettings(false)} />}
    </div>
  );
}
