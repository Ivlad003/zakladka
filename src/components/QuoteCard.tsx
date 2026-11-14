import { useEffect, useRef, useState } from 'react';
import { Download, Share2, X } from 'lucide-react';
import { cx } from '../lib/utils';

interface Props {
  text: string;
  title: string;
  author: string;
  onClose(): void;
}

interface Look {
  id: string;
  name: string;
  background: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  ink: string;
  soft: string;
  mark: string;
}

const LOOKS: Look[] = [
  {
    id: 'paper',
    name: 'Папір',
    background: (ctx, w, h) => {
      ctx.fillStyle = '#f6efe1';
      ctx.fillRect(0, 0, w, h);
    },
    ink: '#2b2418',
    soft: '#7a6a52',
    mark: '#c9a86a',
  },
  {
    id: 'night',
    name: 'Ніч',
    background: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#16213e');
      g.addColorStop(1, '#0f3460');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
    ink: '#f2f4f8',
    soft: '#a9b6cf',
    mark: '#e9b949',
  },
  {
    id: 'sunset',
    name: 'Захід',
    background: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#ff9a8b');
      g.addColorStop(0.55, '#ff6a88');
      g.addColorStop(1, '#ff99ac');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
    ink: '#ffffff',
    soft: '#fff1f3',
    mark: '#ffffff',
  },
  {
    id: 'plain',
    name: 'Біла',
    background: (ctx, w, h) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    },
    ink: '#111111',
    soft: '#666666',
    mark: '#34508c',
  },
];

const SIZES = { square: { w: 1080, h: 1080, label: 'Квадрат' }, story: { w: 1080, h: 1920, label: 'Сторіз' } } as const;

/** Lines of `text` that fit `width` at the current font; words longer than a line are kept whole. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Draws the card: the quote as large as it fits, then the book under it. */
function draw(canvas: HTMLCanvasElement, look: Look, size: keyof typeof SIZES, quote: string, title: string, author: string): void {
  const { w, h } = SIZES[size];
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  look.background(ctx, w, h);
  const pad = 110;
  const width = w - pad * 2;
  const text = quote.length > 700 ? `${quote.slice(0, 700).replace(/\s+\S*$/, '')}…` : quote;
  const room = h - pad * 2 - 220;
  // The biggest size at which the quote fits the room.
  let fontSize = 72;
  let lines: string[] = [];
  for (; fontSize >= 28; fontSize -= 2) {
    ctx.font = `${fontSize}px Georgia, "Times New Roman", serif`;
    lines = wrap(ctx, text, width);
    if (lines.length * fontSize * 1.38 <= room) break;
  }
  const lineHeight = fontSize * 1.38;
  const block = lines.length * lineHeight;
  let y = (h - block - 200) / 2 + fontSize;
  // A large opening quotation mark.
  ctx.fillStyle = look.mark;
  ctx.font = `bold 170px Georgia, serif`;
  ctx.fillText('“', pad - 18, y - fontSize * 0.2 + 10 - 40);
  ctx.fillStyle = look.ink;
  ctx.font = `${fontSize}px Georgia, "Times New Roman", serif`;
  for (const line of lines) {
    ctx.fillText(line, pad, y);
    y += lineHeight;
  }
  // The book.
  y += 40;
  ctx.fillStyle = look.mark;
  ctx.fillRect(pad, y, 80, 5);
  y += 62;
  ctx.fillStyle = look.ink;
  ctx.font = `600 40px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const titleLine = wrap(ctx, title, width)[0] ?? '';
  ctx.fillText(titleLine, pad, y);
  if (author) {
    y += 54;
    ctx.fillStyle = look.soft;
    ctx.font = `36px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText(wrap(ctx, author, width)[0] ?? '', pad, y);
  }
}

const toBlob = (canvas: HTMLCanvasElement) => new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));

/** A quote as a picture to share: a few looks, square or story-sized; shared through the system or saved. */
export function QuoteCard({ text, title, author, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [look, setLook] = useState(LOOKS[0]);
  const [size, setSize] = useState<keyof typeof SIZES>('square');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (canvasRef.current) draw(canvasRef.current, look, size, text.replace(/\s+/g, ' ').trim(), title, author);
  }, [look, size, text, title, author]);

  const fileName = `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 40) || 'quote'} — цитата.png`;
  const share = async () => {
    const blob = await toBlob(canvasRef.current!);
    if (!blob) return;
    const file = new File([blob], fileName, { type: 'image/png' });
    const nav = navigator as Navigator & { canShare?(data: ShareData): boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title, text: `«${text.slice(0, 200)}» — ${title}${author ? `, ${author}` : ''}` });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }
    save(blob);
  };
  const save = (blob?: Blob | null) => {
    const make = blob ? Promise.resolve(blob) : toBlob(canvasRef.current!);
    void make.then((b) => {
      if (!b) return;
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setStatus('Картинку збережено в завантаження.');
    });
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal quote-card" role="dialog" aria-label="Цитата як картинка" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="modal-header">
          <h2>Цитата як картинка</h2>
          <button className="icon-btn" onClick={onClose} title="Закрити" aria-label="Закрити">
            <X size={18} />
          </button>
        </header>
        <div className={cx('quote-preview', size)}>
          <canvas ref={canvasRef} />
        </div>
        <div className="quote-looks">
          {LOOKS.map((l) => (
            <button key={l.id} className={cx('chip', l.id === look.id && 'active')} onClick={() => setLook(l)}>
              {l.name}
            </button>
          ))}
          <span className="spacer" />
          {(Object.keys(SIZES) as (keyof typeof SIZES)[]).map((s) => (
            <button key={s} className={cx('chip', s === size && 'active')} onClick={() => setSize(s)}>
              {SIZES[s].label}
            </button>
          ))}
        </div>
        {status && <p className="muted small">{status}</p>}
        <footer className="modal-footer">
          <button className="btn" onClick={() => save()}>
            <Download size={16} /> Зберегти
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={() => void share()}>
            <Share2 size={16} /> Поділитися
          </button>
        </footer>
      </div>
    </div>
  );
}
