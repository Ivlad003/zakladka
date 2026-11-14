import { useEffect, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, GripHorizontal, GripVertical, List, Menu, Sparkles, type LucideIcon } from 'lucide-react';
import { useGestureReadout } from '../lib/gestures';
import { clamp, cx } from '../lib/utils';
import { updateSettings, useSettings } from '../settings';

interface Props {
  onPrev(): void;
  onNext(): void;
  /** Shows or hides the bars; absent where the bars are always visible. */
  onMenu?: () => void;
  onBookmark(): void;
  bookmarked: boolean;
  onToc(): void;
  onAi(): void;
}

/** How long a page button is held before it starts turning pages on its own, and how fast it then goes. */
const HOLD_DELAY = 450;
const REPEAT_EVERY = 280;

/**
 * A small floating group of buttons for turning pages: one tap — one page, hold — pages keep
 * turning. It can be dragged anywhere by its grip and stays where it was left. Plain buttons work
 * in every browser, including where swipes and taps on the page are swallowed.
 */
export function TurnButtons({ onPrev, onNext, onMenu, onBookmark, bookmarked, onToc, onAi }: Props) {
  const settings = useSettings();
  const ref = useRef<HTMLDivElement>(null);
  const [dragged, setDragged] = useState<{ x: number; y: number } | null>(null);
  const grabRef = useRef<{ dx: number; dy: number } | null>(null);
  const repeatRef = useRef<{ wait?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> }>({});
  const vertical = settings.turnButtonsVertical;
  const position = dragged ?? settings.turnButtonsPos ?? (vertical ? { x: 0.9, y: 0.6 } : { x: 0.7, y: 0.82 });

  const stop = () => {
    clearTimeout(repeatRef.current.wait);
    clearInterval(repeatRef.current.every);
    repeatRef.current = {};
  };
  useEffect(() => stop, []);

  /** Pressing turns a page at once; holding keeps turning. */
  const hold = (turn: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      stop();
      turn();
      repeatRef.current.wait = setTimeout(() => {
        repeatRef.current.every = setInterval(turn, REPEAT_EVERY);
      }, HOLD_DELAY);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    // The keyboard has no pointer: Enter and Space arrive as a click with no detail.
    onClick: (e: React.MouseEvent) => e.detail === 0 && turn(),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  // ---- Dragging by the grip ----
  const moveTo = (clientX: number, clientY: number) => {
    const el = ref.current;
    const frame = el?.parentElement?.getBoundingClientRect();
    if (!el || !frame || !grabRef.current) return null;
    const half = { w: el.offsetWidth / 2 + 6, h: el.offsetHeight / 2 + 6 };
    const x = clamp(clientX - grabRef.current.dx, frame.left + half.w, frame.right - half.w);
    const y = clamp(clientY - grabRef.current.dy, frame.top + half.h, frame.bottom - half.h);
    return { x: (x - frame.left) / frame.width, y: (y - frame.top) / frame.height };
  };
  const grip = {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      const box = ref.current!.getBoundingClientRect();
      grabRef.current = { dx: e.clientX - (box.left + box.width / 2), dy: e.clientY - (box.top + box.height / 2) };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    onPointerMove: (e: React.PointerEvent) => {
      const next = moveTo(e.clientX, e.clientY);
      if (next) setDragged(next);
    },
    onPointerUp: (e: React.PointerEvent) => {
      const next = moveTo(e.clientX, e.clientY);
      grabRef.current = null;
      if (next) updateSettings({ turnButtonsPos: next });
      setDragged(null);
    },
    onPointerCancel: () => {
      grabRef.current = null;
      setDragged(null);
    },
  };

  const extras: { id: string; icon: LucideIcon; label: string; onClick: (() => void) | undefined; active?: boolean }[] = [
    { id: 'menu', icon: Menu, label: 'Показати або сховати панелі', onClick: onMenu },
    { id: 'bookmark', icon: bookmarked ? BookmarkCheck : Bookmark, label: bookmarked ? 'Прибрати закладку' : 'Додати закладку', onClick: onBookmark, active: bookmarked },
    { id: 'toc', icon: List, label: 'Зміст', onClick: onToc },
    { id: 'ai', icon: Sparkles, label: 'AI-агенти', onClick: onAi },
  ];
  const Grip = vertical ? GripHorizontal : GripVertical;

  return (
    <div
      ref={ref}
      className={cx('turn-buttons', vertical && 'vertical', settings.turnButtonsSize, dragged && 'dragging')}
      style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%` }}
      role="group"
      aria-label="Гортання сторінок"
    >
      <button className="turn-grip" {...grip} title="Перетягніть, щоб пересунути" aria-label="Пересунути кнопки">
        <Grip size={16} />
      </button>
      <button className="turn-btn" {...hold(onPrev)} title="Назад (утримуйте, щоб гортати швидко)" aria-label="Попередня сторінка">
        {vertical ? <ChevronUp /> : <ChevronLeft />}
      </button>
      <button className="turn-btn" {...hold(onNext)} title="Далі (утримуйте, щоб гортати швидко)" aria-label="Наступна сторінка">
        {vertical ? <ChevronDown /> : <ChevronRight />}
      </button>
      {extras
        .filter((extra) => extra.onClick && settings.turnButtonsExtra.includes(extra.id as never))
        .map(({ id, icon: Icon, label, onClick, active }) => (
          <button key={id} className={cx('turn-btn extra', active && 'active')} onClick={onClick} title={label} aria-label={label}>
            <Icon />
          </button>
        ))}
    </div>
  );
}

/** What the touch handling has seen: tells a gesture that never reached the app from one it decided to ignore. */
export function GestureDebug() {
  const r = useGestureReadout();
  return (
    <div className="gesture-debug" aria-hidden>
      дотик: початок {r.start} · рух {r.move} · кінець {r.end} · скасовано {r.cancel}
      <br />
      {r.last || 'ще нічого'}
      {r.outcome && ` → ${r.outcome}`}
    </div>
  );
}
