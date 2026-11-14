import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, LoaderCircle, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import type { Engine } from '../engines/types';
import { db } from '../db';
import { buildXray, passagesAbout, saveXray, saveXrayNote, storedXray, type XrayIndex, type XrayTerm } from '../lib/xray';
import { cx } from '../lib/utils';

interface Props {
  bookId: string;
  engine: Engine;
  /** Where the reader is: descriptions use only what comes before it. */
  unit: number;
  unitLabel(unit: number): string;
  /** A term to open straight away (from the dictionary card). */
  initialTerm?: string | null;
  onGo(unit: number): void;
  /** Asks the AI for a short description; absent when no AI is set up. */
  describe?: (task: string, passages: string) => Promise<string>;
  onClose(): void;
}

const BINS = 60;

/** Where in the book a name appears: one strip, darker where it is mentioned more; a line marks the reader's place. */
function Spread({ term, unitCount, unit }: { term: XrayTerm; unitCount: number; unit: number }) {
  const bins = new Array<number>(BINS).fill(0);
  for (const [u, n] of term.units) bins[Math.min(BINS - 1, Math.floor((u / Math.max(1, unitCount)) * BINS))] += n;
  const max = Math.max(...bins, 1);
  const here = (unit / Math.max(1, unitCount - 1)) * 100;
  return (
    <svg className="xray-spread" viewBox="0 0 100 10" preserveAspectRatio="none" aria-label={`Згадки по книзі: ${term.count}`}>
      <rect x="0" y="0" width="100" height="10" className="xray-spread-bg" />
      {bins.map((n, i) => (n ? <rect key={i} x={(i * 100) / BINS} y="0" width={100 / BINS - 0.3} height="10" className="xray-spread-mark" opacity={0.3 + (0.7 * n) / max} /> : null))}
      <line x1={here} x2={here} y1="0" y2="10" className="xray-spread-here" />
    </svg>
  );
}

/** X-Ray: names the book returns to, where each appears, and (on request) what the AI makes of them so far. */
export function XrayPanel({ bookId, engine, unit, unitLabel, initialTerm, onGo, describe, onClose }: Props) {
  const [index, setIndex] = useState<XrayIndex | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(initialTerm ?? null);
  const [filter, setFilter] = useState('');
  const [mentions, setMentions] = useState<{ unit: number; text: string }[] | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const build = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ done: 0, total: engine.unitCount });
    try {
      const made = await buildXray(engine, (done, total) => setProgress({ done, total }), controller.signal);
      await saveXray(bookId, made);
      setIndex(made);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      const kept = await storedXray(bookId);
      const row = await db.xray.get(bookId);
      if (!alive) return;
      setNotes(row?.notes ?? {});
      if (kept) setIndex(kept);
      else void build();
    })();
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, engine]);

  const terms = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase();
    return (index?.terms ?? []).filter((t) => !q || t.name.toLocaleLowerCase().includes(q));
  }, [index, filter]);
  const openTerm = index?.terms.find((t) => t.name === open) ?? null;

  useEffect(() => {
    setMentions(null);
    if (!openTerm) return;
    let alive = true;
    void passagesAbout(engine, openTerm, Number.MAX_SAFE_INTEGER, 12).then((found) => alive && setMentions(found));
    return () => {
      alive = false;
    };
  }, [openTerm, engine]);

  const ask = async (term: XrayTerm) => {
    if (!describe) return;
    setAsking(term.name);
    setError(null);
    try {
      const before = await passagesAbout(engine, term, unit, 8);
      if (!before.length) {
        setError(`До цього місця книги «${term.name}» ще не згадується — опис розкрив би наступне.`);
        return;
      }
      const passages = before.map((p) => `[${unitLabel(p.unit)}] …${p.text}…`).join('\n\n');
      const text = await describe(
        `Describe who or what «${term.name}» is in this book in two or three sentences, for someone reading it now. Use only the passages given (they come from the part of the book the reader has already read); do not read further in the book and do not reveal anything that happens later. If the passages do not make it clear, say what they do show.`,
        passages,
      );
      const note = text.trim();
      if (note) {
        await saveXrayNote(bookId, term.name, note);
        setNotes((n) => ({ ...n, [term.name]: note }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(null);
    }
  };

  return (
    <aside className="side-panel xray-panel">
      <header className="panel-tabs">
        <strong className="xray-title">X-Ray</strong>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => void build()} disabled={Boolean(progress)} title="Скласти заново" aria-label="Скласти заново">
          <RefreshCw size={16} />
        </button>
        <button className="icon-btn" onClick={onClose} title="Закрити" aria-label="Закрити">
          <X size={18} />
        </button>
      </header>
      <div className="panel-body">
        <p className="panel-meta">Імена й назви, до яких книга повертається, і де вони трапляються. Риска — ваше місце в книзі.</p>
        {progress && (
          <div className="made-toc">
            <p className="panel-meta">
              <LoaderCircle size={14} className="spin" /> Читаю книгу: {progress.done} з {progress.total}
            </p>
            <div className="search-progress">
              <div className="bar" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
            </div>
          </div>
        )}
        {index && (
          <form className="search-form" onSubmit={(e) => e.preventDefault()}>
            <Search size={16} className="search-icon" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Знайти ім’я…" aria-label="Знайти ім’я" />
          </form>
        )}
        {index && !index.terms.length && <p className="panel-empty">Імен, які б часто повторювалися, у тексті не знайшлося.</p>}
        {error && <p className="error-text small">{error}</p>}
        <ul className="xray-list">
          {terms.map((t) => {
            const expanded = t.name === open;
            return (
              <li key={t.name} className={cx(expanded && 'open')}>
                <button className="xray-row" onClick={() => setOpen(expanded ? null : t.name)} aria-expanded={expanded}>
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="xray-name">{t.name}</span>
                  <span className="muted">{t.count}</span>
                </button>
                <Spread term={t} unitCount={index!.unitCount} unit={unit} />
                {expanded && (
                  <div className="xray-detail">
                    {notes[t.name] ? (
                      <p className="xray-note">{notes[t.name]}</p>
                    ) : describe ? (
                      <button className="btn small" onClick={() => void ask(t)} disabled={asking !== null}>
                        {asking === t.name ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />} Хто це? (AI, без спойлерів)
                      </button>
                    ) : (
                      <p className="muted small">Короткий опис може дати AI — налаштуйте його в «Налаштуваннях AI».</p>
                    )}
                    {mentions === null ? (
                      <p className="muted small">Шукаю згадки…</p>
                    ) : (
                      <ul className="xray-mentions">
                        {mentions.map((m, i) => (
                          <li key={i}>
                            <button
                              className={cx('hit', m.unit > unit && 'ahead')}
                              onClick={() => onGo(m.unit)}
                              title={m.unit > unit ? 'Далі за вашим місцем у книзі' : undefined}
                            >
                              <span className="hit-label">
                                {unitLabel(m.unit)}
                                {m.unit > unit ? ' · далі' : ''}
                              </span>
                              <span className="hit-text">…{m.text.slice(0, 220)}…</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
