import { useState } from 'react';
import { ClipboardPaste, X } from 'lucide-react';

interface Props {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}

/**
 * The field for a GitHub token, the same in the AI settings and in the dialog that makes a book from
 * a repository. A token is long and is always pasted, never typed, so there is a button that takes
 * it from the clipboard: on a phone that needs neither the keyboard nor a long press in the field.
 */
export function GithubTokenField({ value, onChange, disabled }: Props) {
  const [note, setNote] = useState<string | null>(null);
  // Reading the clipboard is offered only to pages opened over HTTPS (or on the device itself).
  const canPaste = typeof navigator.clipboard?.readText === 'function';

  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return setNote('У буфері обміну немає тексту: спершу скопіюйте токен на сторінці GitHub.');
      if (/\s/.test(text) || text.length > 255) return setNote('У буфері обміну не токен: у токені немає пробілів і він коротший.');
      onChange(text);
      setNote(/^(github_pat_|gh[pousr]_)/.test(text) || /^[0-9a-f]{40}$/.test(text) ? 'Токен вставлено.' : 'Вставлено, хоча на токен GitHub це не схоже: він починається з github_pat_ або ghp_.');
    } catch {
      setNote('Браузер не дав прочитати буфер обміну. Торкніться поля й утримуйте палець — з’явиться «Вставити».');
    }
  };

  return (
    <div className="field column github-token">
      <span>Токен GitHub</span>
      <div className="key-row">
        <input
          type="password"
          value={value}
          onChange={(e) => {
            setNote(null);
            onChange(e.target.value.trim());
          }}
          placeholder="github_pat_…"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={disabled}
          aria-label="Токен GitHub"
        />
        {canPaste && (
          <button type="button" className="btn" onClick={() => void paste()} disabled={disabled}>
            <ClipboardPaste size={16} /> Вставити
          </button>
        )}
        {value && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              setNote(null);
              onChange('');
            }}
            disabled={disabled}
            title="Прибрати токен"
            aria-label="Прибрати токен"
          >
            <X size={16} />
          </button>
        )}
      </div>
      {note && (
        <small className="muted" role="status">
          {note}
        </small>
      )}
      <small className="muted">
        Потрібен для книжок із приватних репозиторіїв і коли бракує запитів: без токена GitHub дає 60 запитів на годину й показує лише відкриті репозиторії, з токеном — 5000 і ваші приватні. Досить доступу лише на читання (Contents і Pull
        requests — Read-only). Токен зберігається тільки в цьому браузері й надсилається лише на api.github.com.
      </small>
    </div>
  );
}
