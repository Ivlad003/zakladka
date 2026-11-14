import { SketchPreview } from './SketchPad';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Check, MapPin, Sparkles, X } from 'lucide-react';
import { intervalLabel, preview, type Rating } from '../lib/fsrs';
import { setJump } from '../lib/jump';
import { answerCard, buildQueue, isDue } from '../lib/study';
import { cx, pluralUk } from '../lib/utils';
import { useSettings } from '../settings';
import type { MemoryPalace, StudyCard, StudyTopic } from '../types';

interface Props {
  /** Every card there is: decides how many new ones may still be started today. */
  allCards: StudyCard[];
  /** The cards this session is about. */
  cards: StudyCard[];
  topics: StudyTopic[];
  palaces: MemoryPalace[];
  /** Set for a walk through a memory palace: its stops are visited in order, whatever is due. */
  walk?: MemoryPalace;
  onExit(): void;
  onOpenBook(bookId: string): void;
}

/** One thing on screen: a single card, or everything left at one stop of a palace. */
interface Step {
  cards: StudyCard[];
  locus?: string;
}

const RATINGS: { rating: Rating; label: string; className: string }[] = [
  { rating: 1, label: 'Знову', className: 'again' },
  { rating: 2, label: 'Важко', className: 'hard' },
  { rating: 3, label: 'Добре', className: 'good' },
  { rating: 4, label: 'Легко', className: 'easy' },
];

/**
 * A review session. The answer stays hidden until asked for: trying to recall it first is what
 * strengthens the memory. The reader then says how it went, and the scheduler picks the next date.
 */
export function StudyReview({ allCards, cards, topics, palaces, walk, onExit, onOpenBook }: Props) {
  const settings = useSettings();
  // The queue is fixed when the session starts; answers given during it must not reshuffle it.
  const [queue, setQueue] = useState<Step[]>(() => {
    if (!walk) return buildQueue(allCards, cards, Date.now()).map((card) => ({ cards: [card] }));
    return walk.loci.map((locus) => ({ locus: locus.name, cards: cards.filter((c) => c.locusId === locus.id) })).filter((step) => step.cards.length);
  });
  const [position, setPosition] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [tally, setTally] = useState({ answered: 0, forgotten: 0 });
  const total = useMemo(() => queue.length, [queue.length]);
  const step = queue[position];

  const answer = useCallback(
    async (rating: Rating) => {
      if (!step) return;
      const now = Date.now();
      const again: StudyCard[] = [];
      for (const card of step.cards) {
        // In a walk, cards that are not due yet are only practised: their schedule stays as it is.
        const counts = !walk || card.state === 'new' || isDue(card, now);
        const updated = counts ? await answerCard(card, rating, now) : card;
        if (rating === 1) again.push(updated);
      }
      setTally((t) => ({ answered: t.answered + 1, forgotten: t.forgotten + (rating === 1 ? 1 : 0) }));
      // What was forgotten comes back at the end of this session, until it is recalled.
      if (again.length) setQueue((q) => [...q, { locus: step.locus, cards: again }]);
      setRevealed(false);
      setPosition((p) => p + 1);
    },
    [step, walk],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') return onExit();
      if (!step) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && /^[1-4]$/.test(e.key)) {
        void answer(Number(e.key) as Rating);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, revealed, answer, onExit]);

  if (!step) {
    const nextDue = Math.min(...cards.filter((c) => c.state !== 'new').map((c) => c.due), Infinity);
    return (
      <div className="review">
        <div className="review-done">
          <Check size={40} />
          {tally.answered ? (
            <>
              <h1>{walk ? 'Маршрут пройдено' : 'На сьогодні все'}</h1>
              <p className="muted">
                {tally.answered} {pluralUk(tally.answered, 'відповідь', 'відповіді', 'відповідей')}
                {tally.forgotten > 0 && `, з них ${tally.forgotten} довелося повторити`}.
              </p>
            </>
          ) : (
            <>
              <h1>Зараз нічого повторювати</h1>
              <p className="muted">{walk ? 'У цьому палаці ще нічого не розкладено.' : 'Картки з’являться тут, коли настане їхній час.'}</p>
            </>
          )}
          {Number.isFinite(nextDue) && nextDue > Date.now() && (
            <p className="muted">Наступне повторення: {new Date(nextDue).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })}.</p>
          )}
          <button className="btn primary large" onClick={onExit}>
            Готово
          </button>
        </div>
      </div>
    );
  }

  const single = step.cards.length === 1 && !walk ? step.cards[0] : null;
  const first = step.cards[0];
  const palace = palaces.find((p) => p.id === first.palaceId);
  const locusName = step.locus ?? palace?.loci.find((l) => l.id === first.locusId)?.name;
  const next = preview(first, Date.now(), settings.studyRetention);
  // In a walk, a card that is not due yet is only practised: its schedule does not change.
  const scheduled = !walk || first.state === 'new' || isDue(first, Date.now());
  const openInBook = (card: StudyCard) => {
    if (!card.bookId) return;
    setJump({ bookId: card.bookId, unit: card.unit, passage: card.quote });
    onOpenBook(card.bookId);
  };

  return (
    <div className="review">
      <header className="review-bar">
        <button className="icon-btn" onClick={onExit} title="Завершити" aria-label="Завершити">
          <X size={20} />
        </button>
        <div className="review-progress">
          <div style={{ width: `${Math.round((position / Math.max(1, total)) * 100)}%` }} />
        </div>
        <span className="muted">
          {position + 1} / {total}
        </span>
      </header>

      <main className="review-card">
        {single && <div className="review-topic">{topics.find((t) => t.id === single.topicId)?.title}</div>}
        {locusName && (
          <div className="review-locus">
            <MapPin size={16} />
            {walk ? (
              <strong>{locusName}</strong>
            ) : (
              <span>
                {palace?.name} → <strong>{locusName}</strong>
              </span>
            )}
          </div>
        )}
        {single ? <div className="review-front">{single.front}</div> : <div className="review-front">Що лежить на цьому місці?</div>}

        {!revealed ? (
          <p className="muted review-tip">{walk ? 'Уявіть це місце й те, що ви там залишили.' : 'Спершу спробуйте згадати самі — саме спроба й закріплює пам’ять.'}</p>
        ) : (
          step.cards.map((card) => (
            <div className="review-answer" key={card.id}>
              {!single && <div className="review-question">{card.front}</div>}
              <div className="review-back">{card.back}</div>
              {card.image && (
                <div className="review-image">
                  <Sparkles size={15} /> {card.image}
                </div>
              )}
              {card.sketch?.strokes.length ? <SketchPreview strokes={card.sketch.strokes} aspect={card.sketch.aspect} /> : null}
              {card.bookId && card.unit !== undefined && (
                <button className="link review-source" onClick={() => openInBook(card)}>
                  <BookOpen size={14} /> Відкрити в книзі{card.label ? ` · ${card.label}` : ''}
                </button>
              )}
            </div>
          ))
        )}
      </main>

      <footer className="review-actions">
        {!revealed ? (
          <button className="btn primary large" onClick={() => setRevealed(true)}>
            Показати відповідь
          </button>
        ) : (
          RATINGS.map(({ rating, label, className }) => (
            <button key={rating} className={cx('rate-btn', className)} onClick={() => void answer(rating)}>
              <strong>{label}</strong>
              <small>{scheduled ? intervalLabel(next[rating]) : 'тренування'}</small>
            </button>
          ))
        )}
      </footer>
    </div>
  );
}
