import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import type { AiFill } from '../ai/quick';

interface Props {
  fill: AiFill;
  label: string;
  /** What to ask for, worked out when the button is pressed; null when there is nothing to go on. */
  task(): string | null;
  quote?: string;
  onResult(text: string): void;
}

/** "Let the AI write this field": runs one request and hands back the text, or says why it could not. */
export function AiFillButton({ fill, label, task, quote, onResult }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const run = async () => {
    const request = task();
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      const text = await fill(request, quote);
      if (alive.current) onResult(text);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="btn small ai-fill" onClick={() => void run()} disabled={busy}>
        {busy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />} {busy ? 'Пишу…' : label}
      </button>
      {error && <small className="error-text">{error}</small>}
    </>
  );
}
