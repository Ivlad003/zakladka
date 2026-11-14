import { appendSpoken, MicButton, voiceTypingSupported } from './MicButton';
import { useEffect, useRef, useState } from 'react';
import { Pencil, X } from 'lucide-react';
import type { AiFill } from '../ai/quick';
import { AiFillButton } from './AiFillButton';
import type { Annotation, HighlightColor, Stroke } from '../types';
import { SKETCH_ASPECT, SketchPad } from './SketchPad';
import { ColorDots } from './Popup';

interface Props {
  annotation: Annotation;
  isNew: boolean;
  onSave(annotation: Annotation): void;
  onDelete(): void;
  onClose(): void;
  /** Lets the model draft the note; absent where no AI is at hand. */
  fill?: AiFill;
}


/** Note editor: text plus a freehand sketch. */
export function NoteEditor({ annotation, isNew, onSave, onDelete, onClose, fill }: Props) {
  const [text, setText] = useState(annotation.text ?? '');
  const [color, setColor] = useState<HighlightColor>(annotation.color);
  const [strokes, setStrokes] = useState<Stroke[]>(annotation.sketch?.strokes ?? []);
  const [sketchOpen, setSketchOpen] = useState(Boolean(annotation.sketch?.strokes.length));
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const save = () => {
    onSave({
      ...annotation,
      type: annotation.type === 'bookmark' ? 'bookmark' : 'note',
      text: text.trim(),
      color,
      sketch: strokes.length ? { aspect: annotation.sketch?.aspect ?? SKETCH_ASPECT, strokes } : null,
      updatedAt: Date.now(),
    });
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal note-editor"
        role="dialog"
        aria-label="Нотатка"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
        }}
      >
        <header className="modal-header">
          <h2>
            Нотатка <span className="muted">· {annotation.label}</span>
          </h2>
          <button className="icon-btn" onClick={onClose} title="Закрити">
            <X size={18} />
          </button>
        </header>

        {annotation.quote && <blockquote className="note-quote">{annotation.quote}</blockquote>}

        <textarea
          ref={textRef}
          className="note-text"
          placeholder="Ваші думки…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
        />
        <div className="voice-row">
          <MicButton onText={(spoken) => setText((current) => appendSpoken(current, spoken))} />
          {voiceTypingSupported && <small className="muted">Диктувати голосом</small>}
          <span className="spacer" />
          {fill && (
            <AiFillButton
              fill={fill}
              label={text.trim() ? 'Доповнити з AI' : 'Написати з AI'}
              quote={annotation.quote}
              task={() =>
                text.trim()
                  ? `Improve and complete this draft of my note, keeping what I mean and my wording where it is fine:\n"""\n${text.trim()}\n"""`
                  : annotation.quote
                    ? 'Write a note about the selected fragment for my notes: in two or three sentences, what it says and why it matters.'
                    : 'Write a note for my notes about the page I have open: its key idea in two or three sentences.'
              }
              onResult={setText}
            />
          )}
        </div>

        {sketchOpen ? (
          <SketchPad strokes={strokes} onChange={setStrokes} aspect={annotation.sketch?.aspect ?? SKETCH_ASPECT} />
        ) : (
          <button className="btn ghost" onClick={() => setSketchOpen(true)}>
            <Pencil size={16} /> Додати малюнок
          </button>
        )}

        <footer className="modal-footer">
          <ColorDots value={color} onPick={setColor} />
          <span className="spacer" />
          {!isNew && (
            <button className="btn danger" onClick={onDelete}>
              Видалити
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Скасувати
          </button>
          <button className="btn primary" onClick={save}>
            Зберегти
          </button>
        </footer>
      </div>
    </div>
  );
}

export { SketchPreview } from './SketchPad';
