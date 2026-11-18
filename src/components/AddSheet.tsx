import { useEffect, useRef, useState } from 'react';
import { FileUp, GitBranch, Globe, LoaderCircle, X } from 'lucide-react';
import { findUrl, saveArticle } from '../lib/articles';
import { parseRepoAddress } from '../lib/github';
import { autoSync } from '../lib/sync';

interface Props {
  /** Opens the system's file picker. */
  onPickFiles(): void;
  /** Opens the dialog that makes a book from a repository, with this address if one was given. */
  onRepo(address: string | null): void;
  /** A web address shared from another app or dropped on the library: saved straight away. */
  initialUrl?: string | null;
  onSaved(bookId: string): void;
  onClose(): void;
}

/** "Add": books from the device, or an article from the web saved to read later. */
export function AddSheet({ onPickFiles, onRepo, initialUrl, onSaved, onClose }: Props) {
  const [url, setUrl] = useState(initialUrl ?? '');
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const save = async (address = url) => {
    const target = findUrl(address) ?? (/^[\w-]+(\.[\w-]+)+/.test(address.trim()) ? `https://${address.trim()}` : null);
    if (!target) return setError('Вставте адресу сторінки, що починається з https://');
    // A repository, a pull request or a diff on GitHub is not an article: a book is made of it.
    if (/^https?:\/\/(www\.)?github\.com\/[^/\s]+\/[^/\s]+/i.test(target) && parseRepoAddress(target)) return onRepo(target);
    setError(null);
    try {
      const id = await saveArticle(target, (p) => setStep(p.step));
      autoSync(true);
      onSaved(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStep(null);
    }
  };

  useEffect(() => {
    if (initialUrl) void save(initialUrl);
    else if (matchMedia('(pointer: fine)').matches) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !step && onClose()}>
      <div className="modal add-sheet" role="dialog" aria-label="Додати" onKeyDown={(e) => e.key === 'Escape' && !step && onClose()}>
        <header className="modal-header">
          <h2>Додати</h2>
          <button className="icon-btn" onClick={onClose} disabled={Boolean(step)} title="Закрити" aria-label="Закрити">
            <X size={18} />
          </button>
        </header>
        <button className="add-choice" onClick={onPickFiles} disabled={Boolean(step)}>
          <FileUp size={22} />
          <span>
            <strong>Книги з пристрою</strong>
            <small className="muted">EPUB, PDF, DjVu, FB2, MOBI, JWPUB</small>
          </span>
        </button>
        <button className="add-choice" onClick={() => onRepo(null)} disabled={Boolean(step)}>
          <GitBranch size={22} />
          <span>
            <strong>Репозиторій GitHub — книжка або журнал</strong>
            <small className="muted">Репозиторій, pull request чи різниця між гілками: модель напише про них книжку з діаграмами, або код стане книжкою як є. Потім її можна завантажити як EPUB чи PDF.</small>
          </span>
        </button>
        <div className="add-choice article">
          <Globe size={22} />
          <span>
            <strong>Стаття з інтернету — прочитати пізніше</strong>
            <small className="muted">Застосунок збереже саму статтю з картинками на полиці «Статті»; її можна читати без інтернету, виділяти й питати агентів.</small>
          </span>
        </div>
        <form
          className="article-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            ref={inputRef}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://… (адреса статті)"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            disabled={Boolean(step)}
            aria-label="Адреса статті"
          />
          <button className="btn primary" type="submit" disabled={Boolean(step) || !url.trim()}>
            {step ? <LoaderCircle size={16} className="spin" /> : null} Зберегти
          </button>
        </form>
        {step && <p className="muted small">{step}</p>}
        {error && <p className="error-text small">{error}</p>}
      </div>
    </div>
  );
}
