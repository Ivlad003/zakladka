import { LoaderCircle, ScanText, Square, X } from 'lucide-react';
import { OCR_LANGS, type OcrProgress } from '../lib/ocr';
import { pluralUk } from '../lib/utils';
import { updateSettings, useSettings } from '../settings';

interface Props {
  pageCount: number;
  currentPage: number;
  /** Pages of this book that already have recognised text. */
  recognized: number;
  /** Progress of the running (or just finished) job, if any. */
  progress: OcrProgress | null;
  running: boolean;
  error: string | null;
  onStart(scope: 'page' | 'book'): void;
  onStop(): void;
  onClear(): void;
  onClose(): void;
}

/** Text recognition for scanned pages. */
export function OcrDialog({ pageCount, currentPage, recognized, progress, running, error, onStart, onStop, onClear, onClose }: Props) {
  const { ocrLangs } = useSettings();
  const toggle = (code: string) => {
    const next = ocrLangs.includes(code) ? ocrLangs.filter((c) => c !== code) : [...ocrLangs, code];
    if (next.length) updateSettings({ ocrLangs: next });
  };
  const percent = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Розпізнавання тексту" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="modal-header">
          <h2>
            <ScanText size={18} /> Розпізнавання тексту (OCR)
          </h2>
          <button className="icon-btn" onClick={onClose} title="Закрити">
            <X size={18} />
          </button>
        </header>

        <p className="muted small">
          Для сканованих сторінок без текстового шару. Після розпізнавання на них працюють пошук, виділення, нотатки, смисловий пошук і AI-агенти. Сторінки,
          де текст уже є, пропускаються. Усе відбувається на вашому пристрої; мовні дані завантажуються один раз.
        </p>

        <div className="field column">
          <span>Мови тексту</span>
          <div className="presets">
            {OCR_LANGS.map((l) => (
              <button key={l.code} className={`chip${ocrLangs.includes(l.code) ? ' active' : ''}`} onClick={() => toggle(l.code)} disabled={running} aria-pressed={ocrLangs.includes(l.code)}>
                {l.name}
              </button>
            ))}
          </div>
          <small className="muted">Обирайте лише ті мови, що справді є в книзі: зайві сповільнюють і погіршують результат.</small>
        </div>

        {progress && (
          <div className="job">
            <div className="search-progress">
              <div className="bar" style={{ width: `${percent}%` }} />
            </div>
            <p className="panel-meta">
              {running && <LoaderCircle size={13} className="spin" />} {progress.status} · {progress.done} з {progress.total} · розпізнано {progress.recognized}
            </p>
          </div>
        )}
        {error && <p className="error-text small">{error}</p>}

        <p className="panel-meta">
          {recognized
            ? `У цій книзі розпізнано ${recognized} ${pluralUk(recognized, 'сторінку', 'сторінки', 'сторінок')} з ${pageCount}.`
            : 'Розпізнаних сторінок у цій книзі ще немає.'}
        </p>

        <footer className="modal-footer">
          {recognized > 0 && !running && (
            <button className="btn danger" onClick={onClear}>
              Очистити
            </button>
          )}
          <span className="spacer" />
          {running ? (
            <button className="btn" onClick={onStop}>
              <Square size={14} /> Зупинити
            </button>
          ) : (
            <>
              <button className="btn" onClick={() => onStart('page')}>
                Сторінку {currentPage + 1}
              </button>
              <button className="btn primary" onClick={() => onStart('book')}>
                Усю книгу
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
