import { useState } from 'react';
import { Download, LoaderCircle, Plus, X } from 'lucide-react';
import { db } from '../db';
import { downloadBookFile, downloadBookPdf } from '../lib/book-export';
import { autoSync } from '../lib/sync';
import { markFinished } from '../lib/stats';
import { cx } from '../lib/utils';
import type { BookRecord } from '../types';

interface Props {
  book: BookRecord;
  /** Shelves that exist already, to pick from. */
  shelves: string[];
  onClose(): void;
}

/** Title, author and shelves of a book, as the reader wants them to be. */
export function BookInfoDialog({ book, shelves, onClose }: Props) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author);
  const [tags, setTags] = useState<string[]>(book.tags ?? []);
  const [fresh, setFresh] = useState('');
  const [finished, setFinished] = useState(Boolean(book.finishedAt));
  /** A file being prepared for download, and what went wrong with the last one. */
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const download = async (pdf: boolean) => {
    setSaveError(null);
    setSaving(pdf ? 'Готую PDF…' : 'Готую файл…');
    try {
      if (pdf) await downloadBookPdf(book, setSaving);
      else await downloadBookFile(book);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };
  const known =[...new Set([...shelves, ...tags])].sort((a, b) => a.localeCompare(b, 'uk'));

  const toggle = (name: string) => setTags((now) => (now.includes(name) ? now.filter((t) => t !== name) : [...now, name]));
  const addShelf = () => {
    const name = fresh.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (name && !tags.some((t) => t.toLocaleLowerCase() === name.toLocaleLowerCase())) setTags((now) => [...now, known.find((k) => k.toLocaleLowerCase() === name.toLocaleLowerCase()) ?? name]);
    setFresh('');
  };
  const save = async () => {
    // A shelf name typed but not yet added still counts.
    const typed = fresh.trim().replace(/\s+/g, ' ').slice(0, 40);
    const all = typed && !tags.some((t) => t.toLocaleLowerCase() === typed.toLocaleLowerCase()) ? [...tags, typed] : tags;
    await db.books.update(book.id, { title: title.trim() || book.title, author: author.trim(), tags: all, infoAt: Date.now() });
    autoSync();
    onClose();
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Відомості про книгу" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="modal-header">
          <h2>Відомості про книгу</h2>
          <button className="icon-btn" onClick={onClose} title="Закрити">
            <X size={18} />
          </button>
        </header>
        <label className="field column">
          <span>Назва</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        <label className="field column">
          <span>Автор</span>
          <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Автор невідомий" />
        </label>
        <div className="field column">
          <span>Полиці</span>
          {known.length > 0 && (
            <div className="shelf-pick">
              {known.map((name) => (
                <button key={name} type="button" className={cx('chip', tags.includes(name) && 'active')} aria-pressed={tags.includes(name)} onClick={() => toggle(name)}>
                  {name}
                </button>
              ))}
            </div>
          )}
          <form
            className="shelf-add"
            onSubmit={(e) => {
              e.preventDefault();
              addShelf();
            }}
          >
            <input value={fresh} onChange={(e) => setFresh(e.target.value)} placeholder="Нова полиця: «Навчання», «Прочитати»…" maxLength={40} enterKeyHint="done" />
            <button className="btn small" type="submit" disabled={!fresh.trim()}>
              <Plus size={14} /> Додати
            </button>
          </form>
          <small className="muted">Книга може стояти на кількох полицях. Порожня полиця зникає сама.</small>
        </div>
        <label className="field checkbox">
          <input type="checkbox" checked={finished} onChange={(e) => {
            setFinished(e.target.checked);
            void markFinished(book.id, e.target.checked).then(() => autoSync());
          }} />
          <span>Прочитано{finished && book.finishedAt ? ` (${new Date(book.finishedAt).toLocaleDateString('uk-UA')})` : ''}</span>
        </label>
        {book.sourceUrl && (
          <small className="muted">
            {book.made ? 'Складено з ' : 'Стаття з '}
            <a href={book.sourceUrl} target="_blank" rel="noreferrer">
              {book.made ? `${book.made.repo} (${book.made.what})` : new URL(book.sourceUrl).hostname.replace(/^www\./, '')}
            </a>
            {book.made?.model ? ` · писала модель ${book.made.model}` : book.made ? ' · без AI' : ''}
          </small>
        )}
        <small className="muted">
          Файл: {book.fileName} · {book.format.toUpperCase()}
        </small>
        {!book.cloudOnly && (
          <div className="book-downloads">
            <button type="button" className="btn small" onClick={() => void download(false)} disabled={Boolean(saving)}>
              <Download size={14} /> Завантажити {book.format.toUpperCase()}
            </button>
            {/* A PDF is laid out only from books the app composed itself: their pages are known to it. */}
            {book.made && book.format === 'epub' && (
              <button type="button" className="btn small" onClick={() => void download(true)} disabled={Boolean(saving)}>
                {saving ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />} Завантажити PDF
              </button>
            )}
            {saving && <small className="muted">{saving}</small>}
            {saveError && <small className="error-text">{saveError}</small>}
          </div>
        )}
        <footer className="modal-footer">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Скасувати
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Зберегти
          </button>
        </footer>
      </div>
    </div>
  );
}
