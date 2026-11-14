import { useEffect, useState } from 'react';
import { BookA, ExternalLink, LoaderCircle, Sparkles, Users } from 'lucide-react';
import { lookUp, type Definition } from '../lib/dictionary';

interface Props {
  word: string;
  /** Asks the explainer agent about the word in its context. */
  onAskAi(): void;
  /** Mentions of the word as a name in this book, when X-Ray knows it. */
  xrayCount?: number;
  onXray?(): void;
}

/** A dictionary entry for a single selected word, from Wiktionary, with the AI as the fallback. */
export function DictionaryCard({ word, onAskAi, xrayCount, onXray }: Props) {
  const [state, setState] = useState<{ status: 'loading' | 'found' | 'none' | 'offline'; entry?: Definition }>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    lookUp(word)
      .then((entry) => alive && setState(entry ? { status: 'found', entry } : { status: 'none' }))
      .catch(() => alive && setState({ status: 'offline' }));
    return () => {
      alive = false;
    };
  }, [word]);

  return (
    <div className="dictionary-card" aria-live="polite">
      <div className="dictionary-head">
        <BookA size={15} />
        <strong>{state.entry && state.entry.lemma.toLocaleLowerCase() !== word.toLocaleLowerCase() ? `${word} → ${state.entry.lemma}` : word}</strong>
        <span className="spacer" />
        {xrayCount && onXray ? (
          <button className="link" onClick={onXray}>
            <Users size={13} /> X-Ray · {xrayCount}
          </button>
        ) : null}
      </div>
      {state.status === 'loading' && (
        <p className="muted small">
          <LoaderCircle size={13} className="spin" /> Шукаю у Вікісловнику…
        </p>
      )}
      {state.status === 'found' && state.entry?.glosses && <p className="muted small">Значення англійською — з англійського Вікісловника:</p>}
      {state.status === 'found' && state.entry && (
        <ol className="dictionary-meanings">
          {state.entry.meanings.slice(0, 3).map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ol>
      )}
      {state.status === 'none' && <p className="muted small">У Вікісловнику цього слова не знайшлося.</p>}
      {state.status === 'offline' && <p className="muted small">Словник зараз недоступний: немає інтернету або Вікісловник не відповідає.</p>}
      <div className="dictionary-actions">
        {state.entry && (
          <a className="link" href={state.entry.url} target="_blank" rel="noreferrer">
            <ExternalLink size={13} /> Вікісловник
          </a>
        )}
        <span className="spacer" />
        <button className="link" onClick={onAskAi}>
          <Sparkles size={13} /> Пояснити в контексті
        </button>
      </div>
    </div>
  );
}
