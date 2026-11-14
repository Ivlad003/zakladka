import { useLayoutEffect, useRef, useState } from 'react';
import { clamp } from '../lib/utils';
import { HIGHLIGHT_COLORS } from '../settings';
import type { HighlightColor, SelectionInfo } from '../types';

/** A small floating toolbar placed under (or above) a spot in the viewport. */
export function Popup({ anchor, children }: { anchor: SelectionInfo['anchor']; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    const below = anchor.bottom + margin;
    const top = below + height > window.innerHeight - margin ? anchor.top - height - margin : below;
    setPos({
      left: clamp(anchor.x - width / 2, margin, window.innerWidth - width - margin),
      top: clamp(top, margin, window.innerHeight - height - margin),
    });
  }, [anchor.x, anchor.top, anchor.bottom]);

  return (
    <div
      ref={ref}
      className="popup"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      // Keep the text selection alive while the buttons are used.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

export function ColorDots({ value, onPick }: { value?: HighlightColor; onPick(color: HighlightColor): void }) {
  const names: Record<string, string> = { yellow: 'Жовтий', green: 'Зелений', blue: 'Синій', pink: 'Рожевий' };
  return (
    <div className="color-dots">
      {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((color) => (
        <button
          key={color}
          className={`color-dot${value === color ? ' selected' : ''}`}
          style={{ background: HIGHLIGHT_COLORS[color] }}
          title={`Виділити: ${names[color].toLowerCase()}`}
          aria-label={names[color]}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  );
}
