import { useState } from 'react';
import { Eraser, Pencil, Trash2, Undo2 } from 'lucide-react';
import { cx } from '../lib/utils';
import type { DrawState, Stroke } from '../types';
import { InkSurface } from './InkSurface';

const PEN_COLORS = ['#1f2328', '#d9364a', '#2b6fd6', '#1e9a55'];
export const SKETCH_ASPECT = 2;

interface Props {
  strokes: Stroke[];
  onChange(strokes: Stroke[]): void;
  /** Width / height of the pad. */
  aspect?: number;
}

/** A small pad for a freehand drawing: pen in a few colours, eraser, undo. */
export function SketchPad({ strokes, onChange, aspect = SKETCH_ASPECT }: Props) {
  const [tool, setTool] = useState<DrawState>({ tool: 'pen', color: PEN_COLORS[0], size: 2.5 });
  return (
    <div className="sketch">
      <div className="sketch-tools">
        <button type="button" className={cx('icon-btn', tool.tool === 'pen' && 'active')} onClick={() => setTool((t) => ({ ...t, tool: 'pen', size: 2.5 }))} title="Олівець">
          <Pencil size={16} />
        </button>
        <button type="button" className={cx('icon-btn', tool.tool === 'eraser' && 'active')} onClick={() => setTool((t) => ({ ...t, tool: 'eraser' }))} title="Гумка">
          <Eraser size={16} />
        </button>
        <span className="tool-sep" />
        {PEN_COLORS.map((c) => (
          <button
            type="button"
            key={c}
            className={cx('swatch', tool.color === c && tool.tool !== 'eraser' && 'selected')}
            style={{ background: c }}
            onClick={() => setTool({ tool: 'pen', color: c, size: 2.5 })}
            aria-label={`Колір ${c}`}
          />
        ))}
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={() => onChange(strokes.slice(0, -1))} disabled={!strokes.length} title="Скасувати останній штрих">
          <Undo2 size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => onChange([])} disabled={!strokes.length} title="Очистити малюнок">
          <Trash2 size={16} />
        </button>
      </div>
      <div className="sketch-pad" style={{ aspectRatio: String(aspect) }}>
        <InkSurface strokes={strokes} tool={tool} onChange={onChange} />
      </div>
    </div>
  );
}

/** Read-only miniature of a sketch, for lists and the answer side of a card. */
export function SketchPreview({ strokes, aspect }: { strokes: Stroke[]; aspect: number }) {
  return (
    <div className="sketch-preview" style={{ aspectRatio: String(aspect) }}>
      <InkSurface strokes={strokes} tool={null} />
    </div>
  );
}
