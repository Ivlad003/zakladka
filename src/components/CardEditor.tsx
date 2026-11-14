import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Pencil, Trash2, X } from 'lucide-react';
import type { AiFill } from '../ai/quick';
import { db } from '../db';
import { addCards, deleteCard, topicForBook, updateCard, type CardDraft } from '../lib/study';
import type { BookRecord, Stroke, StudyCard } from '../types';
import { SKETCH_ASPECT, SketchPad } from './SketchPad';
import { AiFillButton } from './AiFillButton';
import { appendSpoken, MicButton } from './MicButton';

interface Props {
  /** An existing card to change… */
  card?: StudyCard;
  /** …or what a new one starts from, and where it goes: a topic, or the default topic of a book. */
  draft?: Partial<CardDraft>;
  target?: { topicId: string } | { book: Pick<BookRecord, 'id' | 'title'> };
  /** Lets the model write a side of the card; absent where no book is open. */
  fill?: AiFill;
  onClose(): void;
}

/** Writing or changing one study card: the question, the answer, and its place in a memory palace. */
export function CardEditor({ card, draft, target, fill, onClose }: Props) {
  const palaces = useLiveQuery(() => db.palaces.toArray(), []) ?? [];
  const [front, setFront] = useState(card?.front ?? draft?.front ?? '');
  const [back, setBack] = useState(card?.back ?? draft?.back ?? '');
  const [palaceId, setPalaceId] = useState(card?.palaceId ?? '');
  const [locusId, setLocusId] = useState(card?.locusId ?? '');
  const [image, setImage] = useState(card?.image ?? '');
  const [strokes, setStrokes] = useState<Stroke[]>(card?.sketch?.strokes ?? []);
  const [drawing, setDrawing] = useState(Boolean(card?.sketch?.strokes.length));
  const frontRef = useRef<HTMLTextAreaElement>(null);
  const palace = palaces.find((p) => p.id === palaceId);
  const ready = front.trim() && back.trim();

  useEffect(() => {
    frontRef.current?.focus();
  }, []);

  const save = async () => {
    if (!ready) return;
    const placed = Boolean(palace && locusId);
    const place = {
      palaceId: placed ? palace!.id : undefined,
      locusId: placed ? locusId : undefined,
      image: image.trim() || undefined,
      sketch: placed && strokes.length ? { aspect: card?.sketch?.aspect ?? SKETCH_ASPECT, strokes } : undefined,
    };
    if (card) {
      await updateCard(card.id, { front: front.trim(), back: back.trim(), ...place });
    } else if (target) {
      const topic = 'topicId' in target ? await db.topics.get(target.topicId) : await topicForBook(target.book);
      if (!topic) return onClose();
      const { added } = await addCards(topic, [{ ...draft, front, back }], 'user');
      if (added[0] && (place.palaceId || place.image)) await updateCard(added[0].id, place);
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal card-editor"
        role="dialog"
        aria-label={card ? 'Картка' : 'Нова картка'}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
        }}
      >
        <div className="modal-header">
          <h2>{card ? 'Картка' : 'Нова картка'}</h2>
          <button className="icon-btn" onClick={onClose} title="Закрити">
            <X size={18} />
          </button>
        </div>

        <label className="field column">
          <span>Запитання</span>
          <textarea ref={frontRef} rows={2} value={front} onChange={(e) => setFront(e.target.value)} placeholder="Про що треба буде згадати?" />
        </label>
        <label className="field column">
          <span>Відповідь</span>
          <textarea rows={3} value={back} onChange={(e) => setBack(e.target.value)} placeholder="Коротко: одна думка на картку" />
        </label>
        <div className="voice-row">
          <MicButton onText={(spoken) => setBack((current) => appendSpoken(current, spoken))} />
          <span className="spacer" />
          {fill && !front.trim() && (back.trim() || draft?.quote) && (
            <AiFillButton
              fill={fill}
              label="Запитання від AI"
              quote={draft?.quote}
              task={() =>
                `Write the question side of a flashcard. Its answer side is:\n"""\n${back.trim() || draft?.quote}\n"""\nThe question must make me recall that answer, be understandable on its own months later, and not give the answer away.`
              }
              onResult={setFront}
            />
          )}
          {fill && front.trim() && !back.trim() && (
            <AiFillButton
              fill={fill}
              label="Відповідь від AI"
              quote={draft?.quote}
              task={() => `Write the answer side of a flashcard, as short as it can be while complete. The question is:\n"""\n${front.trim()}\n"""`}
              onResult={setBack}
            />
          )}
        </div>
        {draft?.quote && back.trim() !== draft.quote.trim() && <blockquote className="note-quote">{draft.quote}</blockquote>}

        {palaces.length > 0 && (
          <>
            <div className="field-pair">
              <label className="field column">
                <span>Палац пам’яті</span>
                <select
                  value={palaceId}
                  onChange={(e) => {
                    setPalaceId(e.target.value);
                    setLocusId('');
                  }}
                >
                  <option value="">— не розміщено —</option>
                  {palaces.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field column">
                <span>Місце</span>
                <select value={locusId} onChange={(e) => setLocusId(e.target.value)} disabled={!palace}>
                  <option value="">—</option>
                  {palace?.loci.map((l, i) => (
                    <option key={l.id} value={l.id}>
                      {i + 1}. {l.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {palace && locusId && (
              <label className="field column">
                <span>Образ на цьому місці</span>
                <textarea
                  rows={2}
                  value={image}
                  onChange={(e) => setImage(e.target.value)}
                  placeholder="Що тут відбувається? Що яскравіше, дивніше й рухливіше — то краще тримається."
                />
              </label>
            )}
            {palace &&
              locusId &&
              (drawing ? (
                <SketchPad strokes={strokes} onChange={setStrokes} aspect={card?.sketch?.aspect ?? SKETCH_ASPECT} />
              ) : (
                <button type="button" className="btn ghost" onClick={() => setDrawing(true)}>
                  <Pencil size={16} /> Намалювати образ
                </button>
              ))}
          </>
        )}

        <div className="modal-footer">
          {card && (
            <button
              className="btn danger"
              onClick={() => {
                void deleteCard(card.id);
                onClose();
              }}
            >
              <Trash2 size={15} /> Видалити
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Скасувати
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={!ready}>
            Зберегти
          </button>
        </div>
      </div>
    </div>
  );
}
