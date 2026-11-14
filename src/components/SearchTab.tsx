import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, ScanText, Search, Square, X } from 'lucide-react';
import type { SemanticHit } from '../ai/tools';
import type { BuildProgress } from '../lib/semantic';
import { cx, pluralUk, truncate } from '../lib/utils';
import type { SearchHit } from '../types';

export interface SearchState {
  query: string;
  hits: SearchHit[];
  busy: boolean;
  progress: number;
  /** The query the current hits belong to (empty until a search has run). */
  ranFor: string;
}

export interface SemanticState {
  /** `stale`: an index exists but was built with a different embedding model. */
  status: 'none' | 'building' | 'ready' | 'stale';
  /** Where embeddings are computed, in words; or why they cannot be. */
  backendLabel: string;
  backendMissing: string | null;
  progress: BuildProgress | null;
  passages: number;
  ranFor: string;
  busy: boolean;
  hits: SemanticHit[];
  error: string | null;
}

export interface SearchTabProps {
  search: SearchState;
  activeHit: SearchHit | null;
  onSearch(query: string): void;
  onSearchClear(): void;
  onHitPick(hit: SearchHit): void;
  semantic: SemanticState;
  onSemanticBuild(): void;
  onSemanticCancel(): void;
  onSemanticSearch(query: string): void;
  onSemanticPick(hit: SemanticHit): void;
  onSemanticDelete(): void;
  /** Whether this book can be put through OCR (PDF and DjVu). */
  canOcr: boolean;
  onOpenOcr(): void;
  onOpenAiSettings(): void;
}

type Mode = 'exact' | 'semantic';
// Remembered while the app is open, so reopening the panel returns to the mode last used.
let lastMode: Mode = 'exact';

export function SearchTab(props: SearchTabProps) {
  const { search, semantic } = props;
  const [mode, setModeState] = useState<Mode>(lastMode);
  const [value, setValue] = useState(mode === 'exact' ? search.query : semantic.ranFor);
  const inputRef = useRef<HTMLInputElement>(null);

  const setMode = (m: Mode) => {
    lastMode = m;
    setModeState(m);
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const canQuery = mode === 'exact' || semantic.status === 'ready';
  const submit = () => {
    const q = value.trim();
    if (!q || !canQuery) return;
    if (mode === 'exact') props.onSearch(q);
    else props.onSemanticSearch(q);
  };

  return (
    <div className="search-tab">
      <div className="segmented wide" role="tablist" aria-label="Вид пошуку">
        <button role="tab" aria-selected={mode === 'exact'} className={cx(mode === 'exact' && 'active')} onClick={() => setMode('exact')} title="Шукає слова й фрази точно так, як їх написано">
          Точний
        </button>
        <button role="tab" aria-selected={mode === 'semantic'} className={cx(mode === 'semantic' && 'active')} onClick={() => setMode('semantic')} title="Шукає фрагменти за змістом, навіть якщо в них інші слова">
          Смисловий
        </button>
      </div>

      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Search size={16} className="search-icon" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={mode === 'exact' ? 'Слово або фраза…' : 'Запитання або опис того, що шукаєте…'}
          aria-label="Пошук у книзі"
          disabled={!canQuery}
        />
        {value && (
          <button
            type="button"
            className="icon-btn"
            title="Очистити"
            onClick={() => {
              setValue('');
              if (mode === 'exact') props.onSearchClear();
              inputRef.current?.focus();
            }}
          >
            <X size={16} />
          </button>
        )}
      </form>

      {mode === 'exact' ? <ExactResults {...props} /> : <SemanticResults {...props} />}
    </div>
  );
}

function ExactResults({ search, activeHit, onHitPick, canOcr, onOpenOcr }: SearchTabProps) {
  const count = search.hits.length;
  return (
    <>
      {search.busy && (
        <div className="search-progress">
          <div className="bar" style={{ width: `${Math.round(search.progress * 100)}%` }} />
        </div>
      )}
      {search.ranFor && (
        <p className="panel-meta">
          {search.busy ? `Шукаю… знайдено ${count}` : count ? `${count} ${pluralUk(count, 'збіг', 'збіги', 'збігів')}` : `Нічого не знайдено за запитом «${search.ranFor}».`}
        </p>
      )}
      {search.ranFor && !search.busy && !count && canOcr && (
        <div className="hint">
          <p>Якщо це скан без текстового шару, спершу розпізнайте текст.</p>
          <button className="btn small" onClick={onOpenOcr}>
            <ScanText size={14} /> Розпізнати текст (OCR)
          </button>
        </div>
      )}
      <ul className="hits">
        {search.hits.map((hit, i) => (
          <li key={i}>
            <button className={cx('hit', hit === activeHit && 'active')} onClick={() => onHitPick(hit)}>
              <span className="hit-label">{hit.label}</span>
              <span className="hit-text">
                {hit.pre}
                <mark>{hit.match}</mark>
                {hit.post}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function SemanticResults({ semantic, onSemanticBuild, onSemanticCancel, onSemanticPick, onSemanticDelete, onOpenAiSettings, canOcr, onOpenOcr }: SearchTabProps) {
  const { status, progress } = semantic;

  if (status === 'building') {
    const percent = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <div className="hint">
        <div className="search-progress">
          <div className="bar" style={{ width: `${percent}%` }} />
        </div>
        <p>
          <LoaderCircle size={13} className="spin" /> {progress?.status ?? 'Готуюся…'}
          {progress?.total ? ` ${progress.done} з ${progress.total}` : ''}
        </p>
        <button className="btn small" onClick={onSemanticCancel}>
          <Square size={13} /> Зупинити
        </button>
      </div>
    );
  }

  if (status !== 'ready') {
    return (
      <div className="hint">
        <p>
          {status === 'stale'
            ? 'Індекс цієї книги побудовано іншою моделлю ембедингів. Щоб шукати, перебудуйте його.'
            : 'Смисловий пошук знаходить фрагменти за змістом, а не за точними словами. Для цього книгу треба один раз проіндексувати — індекс зберігається в браузері.'}
        </p>
        {semantic.backendMissing ? (
          <>
            <p className="error-text">{semantic.backendMissing}</p>
            <button className="btn small" onClick={onOpenAiSettings}>
              Налаштування AI
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              Ембединги рахуються {semantic.backendLabel}.{' '}
              <button className="link" onClick={onOpenAiSettings}>
                Змінити
              </button>
            </p>
            <button className="btn primary small" onClick={onSemanticBuild}>
              {status === 'stale' ? 'Перебудувати індекс' : 'Побудувати індекс'}
            </button>
          </>
        )}
        {semantic.error && <p className="error-text">{semantic.error}</p>}
        {semantic.error && canOcr && (
          <button className="btn small" onClick={onOpenOcr}>
            <ScanText size={14} /> Розпізнати текст (OCR)
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <p className="panel-meta">
        {semantic.busy
          ? 'Шукаю за змістом…'
          : semantic.ranFor
            ? `Найближчі за змістом фрагменти · у книзі ${semantic.passages}`
            : `Проіндексовано фрагментів: ${semantic.passages}. Поставте запитання своїми словами.`}{' '}
        {!semantic.busy && (
          <button className="link" onClick={onSemanticBuild} title="Перечитати книгу й побудувати індекс заново (наприклад, після OCR)">
            Оновити
          </button>
        )}
        {!semantic.busy && !semantic.ranFor && (
          <>
            {' · '}
            <button className="link" onClick={onSemanticDelete}>
              Видалити індекс
            </button>
          </>
        )}
      </p>
      {semantic.error && <p className="error-text panel-meta">{semantic.error}</p>}
      <ul className="hits">
        {semantic.hits.map((hit, i) => (
          <li key={i}>
            <button className="hit" onClick={() => onSemanticPick(hit)}>
              <span className="hit-label">{hit.label}</span>
              <span className="hit-text">{truncate(hit.text, 260)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
