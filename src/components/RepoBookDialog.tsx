import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Download, GitBranch, GitCommitHorizontal, GitCompare, GitPullRequest, LoaderCircle, Lock, Search, Star, X } from 'lucide-react';
import { resolveProvider } from '../ai/providers';
import { db } from '../db';
import { downloadBookFile, downloadBookPdf } from '../lib/book-export';
import { getRepo, listBranches, listPulls, parseRepoAddress, splitRefPath, type PullSummary, type RepoInfo, type RepoTarget } from '../lib/github';
import { BOOK_SIZES, makeRepoBook, newDraft, readingMinutes, REPO_SHELF, type BookKind, type BookProgress, type BookSize } from '../lib/repo-book';
import { BOOK_LANGS } from '../lib/repo-book-words';
import { autoSync } from '../lib/sync';
import { cx, pluralUk } from '../lib/utils';
import { updateSettings, useSettings } from '../settings';

interface Props {
  /** An address to start from (pasted into "Add", dropped on the library). */
  initialAddress?: string | null;
  onOpenBook(bookId: string): void;
  onOpenAiSettings(): void;
  onClose(): void;
}

type Mode = RepoTarget['type'];

const KINDS: { id: BookKind; name: string; about: string }[] = [
  { id: 'book', name: 'Книжка', about: 'Модель пояснює по розділах: що це за проєкт, як він влаштований і як працює — з діаграмами та уривками коду.' },
  { id: 'magazine', name: 'Журнал', about: 'Номер журналу: головна тема, статті про окремі частини, врізки й діаграми. Легше й жвавіше за книжку.' },
  { id: 'plain', name: 'Код як є', about: 'Без AI: файли й діфи стають сторінками книжки, README — з картинками, зміст — за теками.' },
];
const SIZES: BookSize[] = ['short', 'medium', 'long'];
const PULL_STATE: Record<PullSummary['state'], string> = { open: 'відкритий', merged: 'злитий', closed: 'закритий' };

/** A book or a magazine made from a GitHub repository, a pull request or a diff. */
export function RepoBookDialog({ initialAddress, onOpenBook, onOpenAiSettings, onClose }: Props) {
  const settings = useSettings();
  const [address, setAddress] = useState(initialAddress ?? '');
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [pulls, setPulls] = useState<PullSummary[]>([]);
  const [mode, setMode] = useState<Mode>('repo');
  const [ref, setRef] = useState('');
  const [folder, setFolder] = useState('');
  const [pull, setPull] = useState('');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [sha, setSha] = useState('');
  const [progress, setProgress] = useState<BookProgress | null>(null);
  const [madeId, setMadeId] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [token, setToken] = useState(settings.githubToken);
  const stop = useRef<AbortController | null>(null);
  const draft = useRef(newDraft());
  const inputRef = useRef<HTMLInputElement>(null);
  /** The end of the dialog: progress, an error and the finished book appear there, below a long form. */
  const endRef = useRef<HTMLDivElement>(null);

  const kind = settings.repoBookKind;
  const size = settings.repoBookSize;
  const provider = useMemo(() => resolveProvider(settings), [settings]);
  const busy = Boolean(progress);

  const find = async (text = address) => {
    const parsed = parseRepoAddress(text);
    if (!parsed) return setError('Вкажіть репозиторій як «власник/назва» або вставте посилання з GitHub: на репозиторій, гілку, pull request, порівняння чи коміт.');
    setError(null);
    setFinding(true);
    setRepo(null);
    setMadeId(null);
    try {
      const found = await getRepo(parsed.owner, parsed.name);
      // Without its pull requests a repository can still be read.
      const [names, requests] = await Promise.all([listBranches(found), listPulls(found).catch(() => [] as PullSummary[])]);
      setBranches(names);
      setPulls(requests);
      setRef(found.defaultBranch);
      setFolder('');
      setBase(found.defaultBranch);
      setHead(names.find((n) => n !== found.defaultBranch) ?? found.defaultBranch);
      setPull(requests[0] ? String(requests[0].number) : '');
      setSha('');
      setMode('repo');
      const hint = parsed.hint;
      if (hint?.type === 'pull') {
        setMode('pull');
        setPull(String(hint.number));
      } else if (hint?.type === 'compare') {
        setMode('compare');
        setBase(hint.base);
        setHead(hint.head);
      } else if (hint?.type === 'commit') {
        setMode('commit');
        setSha(hint.sha);
      } else if (hint?.type === 'tree') {
        const where = splitRefPath(hint.refPath, names);
        setRef(where.ref);
        setFolder(where.path);
      }
      setRepo(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinding(false);
    }
  };

  useEffect(() => {
    if (initialAddress) void find(initialAddress);
    else if (matchMedia('(pointer: fine)').matches) inputRef.current?.focus();
    return () => stop.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What has just appeared at the end of the dialog is brought into view.
  const showsEnd = busy || Boolean(madeId) || Boolean(error && repo);
  useEffect(() => {
    if (showsEnd) endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [showsEnd]);

  const target: RepoTarget | null = !repo
    ? null
    : mode === 'repo'
      ? ref
        ? { type: 'repo', ref, path: folder.trim().replace(/^\/+|\/+$/g, '') }
        : null
      : mode === 'pull'
        ? Number(pull) > 0
          ? { type: 'pull', number: Number(pull) }
          : null
        : mode === 'compare'
          ? base && head && base !== head
            ? { type: 'compare', base, head }
            : null
          : sha
            ? { type: 'commit', sha }
            : null;

  const needsModel = kind !== 'plain';
  const ready = Boolean(target) && (!needsModel || 'provider' in provider);

  const make = async () => {
    if (!repo || !target) return;
    setError(null);
    setMadeId(null);
    const controller = new AbortController();
    stop.current = controller;
    setProgress({ step: 'Починаю…', done: 0, total: 1 });
    try {
      const id = await makeRepoBook({ repo, target, kind, size, lang: settings.repoBookLang }, draft.current, setProgress, controller.signal);
      draft.current = newDraft();
      setMadeId(id);
      autoSync(true);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
      stop.current = null;
    }
  };

  const save = async (as: 'epub' | 'pdf') => {
    const book = madeId ? await db.books.get(madeId) : null;
    if (!book) return;
    setError(null);
    setSaving(as === 'pdf' ? 'Готую PDF…' : 'Готую файл…');
    try {
      if (as === 'pdf') await downloadBookPdf(book, setSaving);
      else await downloadBookFile(book);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const chapters = BOOK_SIZES[size].chapters;
  const sizeNote =
    kind === 'plain'
      ? mode === 'repo'
        ? `До ${Math.round(BOOK_SIZES[size].plainChars / 1800 / 10) * 10} сторінок коду: найважливіші файли, скільки вміститься.`
        : 'Розмір визначає, скільки змін показати повністю.'
      : `До ${chapters} ${pluralUk(chapters, 'розділу', 'розділів', 'розділів')}, близько ${readingMinutes(size)} хв читання. Це ${chapters + 1} ${pluralUk(chapters + 1, 'запит', 'запити', 'запитів')} до моделі${mode === 'repo' ? '' : ' (для невеликих змін — менше)'}.`;
  const wide = progress ? Math.round((Math.min(progress.done, progress.total) / Math.max(1, progress.total)) * 100) : 0;
  const pullKnown = pulls.some((p) => String(p.number) === pull);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal repo-book" role="dialog" aria-label="Книжка з репозиторію" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <header className="modal-header">
          <h2>Книжка з репозиторію</h2>
          <button className="icon-btn" onClick={onClose} disabled={busy} title="Закрити" aria-label="Закрити">
            <X size={18} />
          </button>
        </header>

        <form
          className="repo-find"
          onSubmit={(e) => {
            e.preventDefault();
            void find();
          }}
        >
          <input
            ref={inputRef}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="власник/репозиторій або посилання з GitHub"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy || finding}
            aria-label="Репозиторій GitHub"
          />
          <button className="btn" type="submit" disabled={busy || finding || !address.trim()}>
            {finding ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />} Знайти
          </button>
        </form>
        {!repo && !finding && <p className="muted small">Підійде посилання на репозиторій, гілку чи теку, pull request, порівняння гілок або окремий коміт.</p>}

        <details className="help repo-token">
          <summary>Приватний репозиторій або бракує запитів? Додайте токен GitHub{settings.githubToken ? ' (додано)' : ''}</summary>
          <label className="field column">
            <span>Токен GitHub</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onBlur={() => updateSettings({ githubToken: token.trim() })}
              placeholder="github_pat_…"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
          <small className="muted">
            Без токена GitHub дає 60 запитів на годину й показує лише відкриті репозиторії; з токеном — 5000 і ваші приватні. Досить токена лише для читання (Contents і Pull requests — Read-only). Він зберігається тільки в цьому браузері й
            надсилається лише на api.github.com.
          </small>
        </details>

        {repo && (
          <>
            <div className="repo-card">
              {repo.isPrivate ? <Lock size={18} /> : <BookOpen size={18} />}
              <div>
                <strong>{repo.fullName}</strong>
                {repo.description && <small className="muted">{repo.description}</small>}
                <small className="muted">
                  {[repo.language, repo.license, repo.isPrivate ? 'приватний' : ''].filter(Boolean).join(' · ')}
                  {repo.stars > 0 && (
                    <>
                      {repo.language || repo.license ? ' · ' : ''}
                      <Star size={11} /> {repo.stars.toLocaleString('uk-UA')}
                    </>
                  )}
                </small>
              </div>
            </div>

            <div className="field column">
              <span>Що читати</span>
              <div className="segmented wide" role="tablist">
                <button type="button" role="tab" aria-selected={mode === 'repo'} className={cx(mode === 'repo' && 'active')} onClick={() => setMode('repo')} disabled={busy}>
                  <GitBranch size={14} /> Репозиторій
                </button>
                <button type="button" role="tab" aria-selected={mode === 'pull'} className={cx(mode === 'pull' && 'active')} onClick={() => setMode('pull')} disabled={busy}>
                  <GitPullRequest size={14} /> Pull request
                </button>
                <button type="button" role="tab" aria-selected={mode === 'compare'} className={cx(mode === 'compare' && 'active')} onClick={() => setMode('compare')} disabled={busy}>
                  <GitCompare size={14} /> Дві гілки
                </button>
                {(mode === 'commit' || sha) && (
                  <button type="button" role="tab" aria-selected={mode === 'commit'} className={cx(mode === 'commit' && 'active')} onClick={() => setMode('commit')} disabled={busy}>
                    <GitCommitHorizontal size={14} /> Коміт
                  </button>
                )}
              </div>
            </div>

            {mode === 'repo' && (
              <div className="field-pair">
                <label className="field column">
                  <span>Гілка</span>
                  <select value={ref} onChange={(e) => setRef(e.target.value)} disabled={busy}>
                    {!branches.includes(ref) && ref && <option value={ref}>{ref}</option>}
                    {branches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field column">
                  <span>Тека</span>
                  <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="увесь репозиторій" autoCapitalize="none" spellCheck={false} disabled={busy} />
                </label>
              </div>
            )}
            {mode === 'pull' && (
              <div className="field-pair">
                {pulls.length > 0 && (
                  <label className="field column">
                    <span>Нещодавні</span>
                    <select value={pullKnown ? pull : ''} onChange={(e) => setPull(e.target.value)} disabled={busy}>
                      {!pullKnown && <option value="">— за номером —</option>}
                      {pulls.map((p) => (
                        <option key={p.number} value={p.number}>
                          #{p.number} · {p.title.slice(0, 70)} ({p.draft ? 'чернетка' : PULL_STATE[p.state]})
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="field column repo-number">
                  <span>Номер</span>
                  <input value={pull} onChange={(e) => setPull(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="№" disabled={busy} />
                </label>
              </div>
            )}
            {mode === 'compare' && (
              <>
                <div className="field-pair">
                  <label className="field column">
                    <span>Основа</span>
                    <select value={base} onChange={(e) => setBase(e.target.value)} disabled={busy}>
                      {!branches.includes(base) && base && <option value={base}>{base}</option>}
                      {branches.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field column">
                    <span>Гілка зі змінами</span>
                    <select value={head} onChange={(e) => setHead(e.target.value)} disabled={busy}>
                      {!branches.includes(head) && head && <option value={head}>{head}</option>}
                      {branches.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <small className="muted">{base === head ? 'Оберіть дві різні гілки.' : `Книжка буде про те, що є в «${head}» і чого немає в «${base}».`}</small>
              </>
            )}
            {mode === 'commit' && (
              <label className="field column">
                <span>Коміт</span>
                <input value={sha} onChange={(e) => setSha(e.target.value.trim())} placeholder="хеш коміту" autoCapitalize="none" spellCheck={false} disabled={busy} />
              </label>
            )}

            <div className="field column">
              <span>Що зробити</span>
              <div className="segmented wide" role="tablist">
                {KINDS.map((k) => (
                  <button key={k.id} type="button" role="tab" aria-selected={kind === k.id} className={cx(kind === k.id && 'active')} onClick={() => updateSettings({ repoBookKind: k.id })} disabled={busy}>
                    {k.name}
                  </button>
                ))}
              </div>
              <small className="muted">{KINDS.find((k) => k.id === kind)?.about}</small>
            </div>

            <div className="field column">
              <span>Розмір</span>
              <div className="segmented wide" role="tablist">
                {SIZES.map((s) => (
                  <button key={s} type="button" role="tab" aria-selected={size === s} className={cx(size === s && 'active')} onClick={() => updateSettings({ repoBookSize: s })} disabled={busy}>
                    {BOOK_SIZES[s].name}
                  </button>
                ))}
              </div>
              <small className="muted">{sizeNote}</small>
            </div>

            <label className="field">
              <span>Мова книжки</span>
              <select value={settings.repoBookLang} onChange={(e) => updateSettings({ repoBookLang: e.target.value })} disabled={busy}>
                {BOOK_LANGS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            {kind === 'plain' && <small className="muted">Самі файли лишаються як є; мовою книжки будуть заголовки сторінок, які складає застосунок.</small>}

            {needsModel &&
              ('provider' in provider ? (
                <small className="muted">
                  Писатиме {provider.provider.name} (
                  <button type="button" className="link" onClick={onOpenAiSettings} disabled={busy}>
                    змінити
                  </button>
                  ).
                  {provider.provider.kind === 'openai' && provider.provider.id === 'browser' && ' Модель у браузері мала й бачить по кілька сторінок коду за раз — книжка вийде поверховою.'}
                  {provider.provider.kind === 'openai' && provider.provider.id === 'local' && ' Локальній моделі на книжку може знадобитися чимало часу.'}
                </small>
              ) : (
                <p className="notice">
                  <span>Книжку й журнал пише модель. {provider.missing}</span>
                  <button type="button" className="btn small" onClick={onOpenAiSettings}>
                    Налаштування AI
                  </button>
                </p>
              ))}
          </>
        )}

        {progress && (
          <div className="repo-progress" role="status">
            <span>
              <LoaderCircle size={14} className="spin" /> {progress.step}
            </span>
            <div className="search-progress">
              <div className="bar" style={{ width: `${wide}%` }} />
            </div>
          </div>
        )}
        {error && (
          <p className="error-text small" role="alert">
            {error}
            {draft.current.chapters.size > 0 && !busy && ` Написане збережено (${draft.current.chapters.size} з ${draft.current.outline?.chapters.length ?? '?'}): «Продовжити» допише решту.`}
          </p>
        )}
        {madeId && !busy && (
          <div className="repo-done">
            <strong>Готово: книжка стоїть на полиці «{REPO_SHELF}».</strong>
            <div>
              <button className="btn primary" onClick={() => onOpenBook(madeId)}>
                <BookOpen size={16} /> Читати
              </button>
              <button className="btn" onClick={() => void save('epub')} disabled={Boolean(saving)}>
                <Download size={16} /> EPUB
              </button>
              <button className="btn" onClick={() => void save('pdf')} disabled={Boolean(saving)}>
                {saving ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />} PDF
              </button>
            </div>
            {saving && <small className="muted">{saving}</small>}
          </div>
        )}

        {repo && (
          <footer className="modal-footer">
            <span className="spacer" />
            {busy ? (
              <button className="btn" onClick={() => stop.current?.abort()}>
                Зупинити
              </button>
            ) : (
              <>
                <button className="btn" onClick={onClose}>
                  {madeId ? 'Закрити' : 'Скасувати'}
                </button>
                <button className={cx('btn', !madeId && 'primary')} onClick={() => void make()} disabled={!ready}>
                  {draft.current.chapters.size > 0 ? 'Продовжити' : madeId ? 'Зробити ще одну' : kind === 'magazine' ? 'Створити журнал' : 'Створити книжку'}
                </button>
              </>
            )}
          </footer>
        )}
        <div ref={endRef} className="repo-end" />
      </div>
    </div>
  );
}
