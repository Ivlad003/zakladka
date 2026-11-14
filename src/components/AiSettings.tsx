import { useEffect, useMemo, useState } from 'react';
import { Eye, LoaderCircle, RefreshCw, Search, Wrench, X } from 'lucide-react';
import { isBlockedMixedContent, isOpenRouter, listLocalModels, listOpenRouterModels, MIXED_CONTENT_HINT, trimUrl, type ModelInfo } from '../ai/providers';
import { BROWSER_MODELS, canRun, deleteBrowserModel, findBrowserModel, isModelDownloaded, loadBrowserModel, useBrowserModel, webGpuAvailable } from '../ai/browser-llm';
import { DEFAULT_BROWSER_MODEL } from '../lib/semantic';
import { cx, timeoutSignal } from '../lib/utils';
import { voiceTypingSupported } from './MicButton';
import {
  LOCAL_PRESETS,
  MODELS,
  OPENROUTER_URL,
  getSettings,
  updateSettings,
  type AiLanguage,
  type AiProviderId,
  type WebSearch,
  type ContextSize,
  type EmbedBackend,
  type Settings,
} from '../settings';

const PROVIDERS: { id: AiProviderId; label: string }[] = [
  { id: 'anthropic', label: 'Claude' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'local', label: 'Локальні моделі' },
  { id: 'browser', label: 'У браузері' },
];

/** Models that run in the browser; any other Hugging Face id with ONNX weights can be typed in. */
const BROWSER_EMBED_PRESETS: { id: string; name: string }[] = [
  { id: DEFAULT_BROWSER_MODEL, name: 'multilingual-e5-small · багатомовна, 120 МБ' },
  { id: 'Xenova/all-MiniLM-L6-v2', name: 'all-MiniLM-L6-v2 · лише англійська, 25 МБ' },
];

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const formatContext = (n?: number) => (n ? (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}K`) : null);
const formatPrice = (m: ModelInfo) =>
  m.free ? 'безкоштовно' : m.priceIn !== undefined && m.priceOut !== undefined ? `$${+m.priceIn.toFixed(2)} / $${+m.priceOut.toFixed(2)} за 1M` : '';

/** AI settings: which provider answers, its model and key, and how semantic search computes embeddings. */
export function AiSettings({ onClose }: { onClose(): void }) {
  const [draft, setDraft] = useState<Settings>(getSettings);
  const set = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }));

  const save = () => {
    updateSettings({
      ...draft,
      apiKey: draft.apiKey.trim(),
      model: draft.model.trim() || MODELS[0].id,
      anthropicBaseUrl: trimUrl(draft.anthropicBaseUrl),
      openrouterBaseUrl: trimUrl(draft.openrouterBaseUrl) || OPENROUTER_URL,
      embedBrowserModel: draft.embedBrowserModel.trim() || DEFAULT_BROWSER_MODEL,
      openrouterKey: draft.openrouterKey.trim(),
      openrouterModel: draft.openrouterModel.trim(),
      localBaseUrl: draft.localBaseUrl.trim(),
      localModel: draft.localModel.trim(),
      embedBaseUrl: draft.embedBaseUrl.trim(),
      embedModel: draft.embedModel.trim(),
      searxngUrl: trimUrl(draft.searxngUrl),
      // Edited elsewhere and may have changed while this dialog was open.
      theme: getSettings().theme,
      ...syncFields(getSettings()),
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal ai-settings" role="dialog" aria-label="Налаштування AI" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="modal-header">
          <h2>Налаштування AI</h2>
          <button className="icon-btn" onClick={onClose} title="Закрити">
            <X size={18} />
          </button>
        </header>

        <div className="field column">
          <span>Хто відповідає</span>
          <div className="segmented wide">
            {PROVIDERS.map((p) => (
              <button key={p.id} className={cx(draft.aiProvider === p.id && 'active')} onClick={() => set({ aiProvider: p.id })}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {draft.aiProvider === 'anthropic' && <ClaudeSection draft={draft} set={set} />}
        {draft.aiProvider === 'openrouter' && <OpenRouterSection draft={draft} set={set} />}
        {draft.aiProvider === 'local' && <LocalSection draft={draft} set={set} />}
        {draft.aiProvider === 'browser' && <BrowserSection draft={draft} set={set} />}

        <label className="field column">
          <span>Мова відповідей</span>
          <select value={draft.aiLanguage} onChange={(e) => set({ aiLanguage: e.target.value as AiLanguage })}>
            <option value="uk">Українська</option>
            <option value="en">English</option>
            <option value="auto">Мовою запитання</option>
          </select>
        </label>

        <label className="field column">
          <span>Пошук в інтернеті для агентів</span>
          <select value={draft.webSearch} onChange={(e) => set({ webSearch: e.target.value as WebSearch })}>
            <option value="auto">Автоматично: веб-пошук через сервер застосунку, без нього — Вікіпедія</option>
            <option value="wikipedia">Лише Вікіпедія</option>
            <option value="searxng">Власний пошуковий сервіс SearXNG</option>
            <option value="off">Вимкнено</option>
          </select>
          <small className="muted">
            Агент із підтримкою інструментів може шукати довідку поза книгою: хто ця людина, що означає термін. Запит іде до обраного сервісу; текст книги туди не надсилається. «Автоматично» шукає в DuckDuckGo через сервер застосунку (<code>npm run serve</code>) і може відкривати знайдені сторінки; якщо застосунок відкрито інакше — лишається Вікіпедія.
          </small>
        </label>
        {draft.webSearch === 'searxng' && (
          <label className="field column">
            <span>Адреса SearXNG</span>
            <input value={draft.searxngUrl} onChange={(e) => set({ searxngUrl: e.target.value })} placeholder={`${location.origin}/proxy/search`} inputMode="url" autoCapitalize="none" spellCheck={false} />
            <small className="muted">
              Сервіс має віддавати JSON (у його налаштуваннях <code>search.formats</code> з <code>json</code>). Найпростіше — через проксі застосунку:{' '}
              <code>npm run serve -- --proxy search=http://127.0.0.1:8888</code>, тоді адреса — <code>{location.origin}/proxy/search</code>.
            </small>
            <MixedContentWarning url={draft.searxngUrl} />
          </label>
        )}

        <label className="field column">
          <span>Мова голосового введення</span>
          <select value={draft.voiceLang} onChange={(e) => set({ voiceLang: e.target.value })}>
            <option value="">Як мова відповідей</option>
            <option value="uk-UA">Українська</option>
            <option value="en-US">English</option>
            <option value="pl-PL">Polski</option>
            <option value="de-DE">Deutsch</option>
            <option value="fr-FR">Français</option>
            <option value="es-ES">Español</option>
          </select>
          {!voiceTypingSupported && (
            <small className="muted">Цей браузер сам не розпізнає мовлення, тож кнопки мікрофона в застосунку немає. На телефоні диктуйте кнопкою мікрофона на клавіатурі — вона працює в будь-якому полі.</small>
          )}
        </label>

        <EmbeddingSection draft={draft} set={set} />

        <p className="muted small">
          Агенти читають текст відкритої книги та ваші нотатки, щоб відповідати. Ці фрагменти надсилаються обраному провайдеру разом із запитанням; з
          локальними моделями вони не залишають ваш комп’ютер. Ключі зберігаються лише в цьому браузері.
        </p>

        <footer className="modal-footer">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Скасувати
          </button>
          <button className="btn primary" onClick={save}>
            Зберегти
          </button>
        </footer>
      </div>
    </div>
  );
}

/** A model that runs inside this browser: choosing it, downloading it, removing it. */
function BrowserSection({ draft, set }: SectionProps) {
  const running = useBrowserModel();
  const [downloaded, setDownloaded] = useState<boolean | null>(null);
  const chosen = findBrowserModel(draft.browserModel);
  const usable = chosen ? canRun(chosen) : true;
  const loading = running.status === 'loading' && running.model === draft.browserModel;
  const size = (m: { gb: number }) => `${String(m.gb).replace('.', ',')} ГБ`;

  useEffect(() => {
    let alive = true;
    setDownloaded(null);
    if (chosen && usable) void isModelDownloaded(chosen.id).then((yes) => alive && setDownloaded(yes));
    return () => {
      alive = false;
    };
    // The model is identified by its id; a finished download changes the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.browserModel, running.status]);

  return (
    <>
      <label className="field column">
        <span>Модель</span>
        <select value={draft.browserModel} onChange={(e) => set({ browserModel: e.target.value })}>
          <option value="">— оберіть —</option>
          <optgroup label="На процесорі — працює на будь-якому пристрої, і на iPhone">
            {BROWSER_MODELS.filter((m) => m.engine === 'cpu').map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {size(m)} · {m.note}
              </option>
            ))}
          </optgroup>
          <optgroup label={webGpuAvailable() ? 'На відеочипі (WebGPU) — у рази швидше' : 'На відеочипі (WebGPU) — цей браузер не підтримує'}>
            {BROWSER_MODELS.filter((m) => m.engine === 'gpu').map((m) => (
              <option key={m.id} value={m.id} disabled={!webGpuAvailable()}>
                {m.name} · {size(m)} · {m.note}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      {chosen && !usable && <small className="error-text">Цій моделі потрібен WebGPU, а цей браузер його не має. Оберіть модель «на процесорі».</small>}
      {chosen && usable && (
        <div className="hint">
          {loading && (
            <div className="search-progress">
              <div className="bar" style={{ width: `${Math.round(running.progress * 100)}%` }} />
            </div>
          )}
          <p>
            {loading
              ? running.text || 'Завантажую…'
              : downloaded === null
                ? 'Перевіряю, чи модель уже на пристрої…'
                : downloaded
                  ? 'Модель уже на цьому пристрої й працює без інтернету.'
                  : `Модель буде завантажено з Hugging Face — близько ${size(chosen)} — і збережено в браузері. Краще робити це через Wi-Fi й не згортати застосунок, поки триває завантаження.`}
          </p>
          <div className="presets">
            <button className="btn small" disabled={loading} onClick={() => void loadBrowserModel(chosen.id).catch(() => {})}>
              {downloaded ? 'Запустити' : 'Завантажити й запустити'}
            </button>
            {downloaded && !loading && (
              <button className="btn small danger" onClick={() => confirm('Видалити модель із цього пристрою?') && void deleteBrowserModel(chosen.id)}>
                Видалити з пристрою
              </button>
            )}
          </div>
          {running.status === 'ready' && running.model === chosen.id && <p className="muted">Модель запущена.</p>}
          {running.status === 'error' && running.model === chosen.id && <p className="error-text">{running.text}</p>}
        </div>
      )}
      <p className="muted small">
        Модель працює на самому пристрої: текст книги нікуди не надсилається, а після завантаження інтернет не потрібен. Натисніть «Зберегти», щоб агенти почали нею користуватися. Такі моделі
        малі: разом із запитанням вони отримують текст поточної сторінки та (якщо для книги побудовано смисловий індекс) кілька доречних фрагментів з інших місць, але самі шукати по книзі,
        зберігати нотатки чи картки не вміють. Для цього потрібна більша модель — через Ollama чи LM Studio, OpenRouter або Claude.
      </p>
    </>
  );
}

function syncFields(s: Settings): Partial<Settings> {
  return { s3Endpoint: s.s3Endpoint, s3Region: s.s3Region, s3Bucket: s.s3Bucket, s3AccessKey: s.s3AccessKey, s3SecretKey: s.s3SecretKey, s3Prefix: s.s3Prefix, syncAuto: s.syncAuto };
}

interface SectionProps {
  draft: Settings;
  set(patch: Partial<Settings>): void;
}

/** Warns when the browser is going to refuse the address before any request is made. */
function MixedContentWarning({ url }: { url: string }) {
  return isBlockedMixedContent(url) ? <small className="error-text">{MIXED_CONTENT_HINT}</small> : null;
}

function KeyField({ label, value, placeholder, onChange, children }: { label: string; value: string; placeholder: string; onChange(v: string): void; children?: React.ReactNode }) {
  return (
    <label className="field column">
      <span>{label}</span>
      <input type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} />
      {children && <small className="muted">{children}</small>}
    </label>
  );
}

function ClaudeSection({ draft, set }: SectionProps) {
  const listed = MODELS.some((m) => m.id === draft.model);
  const [custom, setCustom] = useState(!listed);
  return (
    <>
      <KeyField label="Ключ Claude API" value={draft.apiKey} placeholder="sk-ant-…" onChange={(apiKey) => set({ apiKey })}>
        Створити ключ можна в{' '}
        <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">
          консолі Claude
        </a>
        . {draft.anthropicBaseUrl.trim() ? `Запити йдуть на ${hostOf(draft.anthropicBaseUrl.trim())}.` : 'Запити йдуть напряму на api.anthropic.com.'}
      </KeyField>
      <div className="field column">
        <span>Модель</span>
        <select
          aria-label="Модель Claude"
          value={custom ? '' : draft.model}
          onChange={(e) => {
            setCustom(!e.target.value);
            if (e.target.value) set({ model: e.target.value });
          }}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} — {m.hint}
            </option>
          ))}
          <option value="">Інша — ввести id моделі</option>
        </select>
        {custom && <input value={draft.model} onChange={(e) => set({ model: e.target.value })} placeholder="id моделі, напр. claude-opus-5-5" aria-label="Id моделі Claude" autoCapitalize="none" spellCheck={false} />}
      </div>
      <details className="help" open={Boolean(draft.anthropicBaseUrl.trim())}>
        <summary>Власна адреса API (шлюз або проксі)</summary>
        <div className="field column">
          <input
            value={draft.anthropicBaseUrl}
            onChange={(e) => set({ anthropicBaseUrl: e.target.value })}
            placeholder="https://api.anthropic.com"
            aria-label="Адреса Claude API"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
          />
          <small className="muted">Залиште порожнім, щоб звертатися до Claude напряму. Власна адреса має говорити мовою Claude Messages API і дозволяти запити з браузера.</small>
          <MixedContentWarning url={draft.anthropicBaseUrl} />
        </div>
      </details>
    </>
  );
}

function CapabilityToggles({ tools, vision, onTools, onVision }: { tools: boolean; vision: boolean; onTools(v: boolean): void; onVision(v: boolean): void }) {
  return (
    <div className="toggles">
      <label className="field checkbox" title="Модель сама читає сторінки, шукає по книзі та зберігає нотатки. Без цього вона бачить лише текст поточної сторінки.">
        <input type="checkbox" checked={tools} onChange={(e) => onTools(e.target.checked)} />
        <span>
          <Wrench size={13} /> Підтримує інструменти
        </span>
      </label>
      <label className="field checkbox" title="Модель може дивитися на сторінку як на зображення: скани, формули, схеми.">
        <input type="checkbox" checked={vision} onChange={(e) => onVision(e.target.checked)} />
        <span>
          <Eye size={13} /> Бачить зображення
        </span>
      </label>
    </div>
  );
}

function OpenRouterSection({ draft, set }: SectionProps) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [freeOnly, setFreeOnly] = useState(() => isOpenRouter(trimUrl(draft.openrouterBaseUrl) || OPENROUTER_URL));
  const [toolsOnly, setToolsOnly] = useState(freeOnly);

  // The catalogue follows the address; typing a new one reloads it after a short pause.
  const baseUrl = trimUrl(draft.openrouterBaseUrl) || OPENROUTER_URL;
  const official = isOpenRouter(baseUrl);
  const catalogueKey = official ? '' : draft.openrouterKey.trim();
  useEffect(() => {
    const controller = new AbortController();
    setModels(null);
    setError(null);
    const timer = setTimeout(() => {
      listOpenRouterModels(baseUrl, catalogueKey, controller.signal)
        .then(setModels)
        .catch((err) => !controller.signal.aborted && setError(err instanceof TypeError ? 'сервер не відповідає або не дозволяє запити з браузера' : err instanceof Error ? err.message : String(err)));
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [baseUrl, catalogueKey]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (models ?? []).filter((m) => (!freeOnly || m.free) && (!toolsOnly || m.tools) && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)));
  }, [models, query, freeOnly, toolsOnly]);

  const freeCount = useMemo(() => (models ?? []).filter((m) => m.free).length, [models]);

  return (
    <>
      <KeyField label="Ключ OpenRouter" value={draft.openrouterKey} placeholder="sk-or-…" onChange={(openrouterKey) => set({ openrouterKey })}>
        Ключ потрібен і для безкоштовних моделей; створити його можна на{' '}
        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
          openrouter.ai/keys
        </a>
        . Запити йдуть на {hostOf(baseUrl)}.
      </KeyField>

      <details className="help" open={!official}>
        <summary>Адреса API</summary>
        <div className="field column">
          <div className="row">
            <input
              value={draft.openrouterBaseUrl}
              onChange={(e) => set({ openrouterBaseUrl: e.target.value })}
              placeholder={OPENROUTER_URL}
              aria-label="Адреса API OpenRouter"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
            />
            {!official && (
              <button className="btn" onClick={() => set({ openrouterBaseUrl: OPENROUTER_URL })}>
                Стандартна
              </button>
            )}
          </div>
          <small className="muted">
            Сюди можна вписати інший хмарний сервіс з OpenAI-сумісним API (адреса зазвичай закінчується на /v1). Позначки «безкоштовно» та ціни показує лише
            каталог OpenRouter.
          </small>
          <MixedContentWarning url={draft.openrouterBaseUrl} />
        </div>
      </details>

      <div className="field column">
        <span>Модель</span>
        <input
          value={draft.openrouterModel}
          onChange={(e) => set({ openrouterModel: e.target.value })}
          placeholder="Оберіть зі списку або введіть id, напр. постачальник/модель"
          spellCheck={false}
        />
        <div className="model-filter">
          <label className="search-form">
            <Search size={14} className="search-icon" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Пошук у каталозі" aria-label="Пошук моделі" />
          </label>
          <label className="field checkbox">
            <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} />
            <span>Безкоштовні{models ? ` (${freeCount})` : ''}</span>
          </label>
          <label className="field checkbox">
            <input type="checkbox" checked={toolsOnly} onChange={(e) => setToolsOnly(e.target.checked)} />
            <span>З інструментами</span>
          </label>
        </div>
        <div className="model-list" role="listbox" aria-label="Моделі OpenRouter">
          {!models && !error && (
            <p className="panel-meta">
              <LoaderCircle size={14} className="spin" /> Завантажую каталог…
            </p>
          )}
          {error && <p className="panel-meta error-text">Не вдалося завантажити каталог: {error}. Id моделі можна ввести вручну.</p>}
          {models && !shown.length && <p className="panel-meta">Нічого не знайдено. Спробуйте зняти фільтри.</p>}
          {shown.slice(0, 150).map((m) => (
            <button
              key={m.id}
              role="option"
              aria-selected={m.id === draft.openrouterModel}
              className={cx('model-row', m.id === draft.openrouterModel && 'active')}
              onClick={() => set({ openrouterModel: m.id, openrouterTools: Boolean(m.tools), openrouterVision: Boolean(m.vision) })}
            >
              <span className="model-name">{m.name}</span>
              <span className="model-meta">
                <span className={cx('badge', m.free && 'free')}>{formatPrice(m)}</span>
                {formatContext(m.contextLength) && <span>{formatContext(m.contextLength)} контексту</span>}
                {m.tools && (
                  <span title="Підтримує інструменти">
                    <Wrench size={12} />
                  </span>
                )}
                {m.vision && (
                  <span title="Бачить зображення">
                    <Eye size={12} />
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
        <small className="muted">Безкоштовні моделі мають денні ліміти запитів, а їхній перелік на OpenRouter часто змінюється.</small>
      </div>

      <CapabilityToggles
        tools={draft.openrouterTools}
        vision={draft.openrouterVision}
        onTools={(openrouterTools) => set({ openrouterTools })}
        onVision={(openrouterVision) => set({ openrouterVision })}
      />
    </>
  );
}

type Preset = { name: string; url: string };
const PROXY_NAMES: Record<string, string> = { ollama: 'Ollama', lmstudio: 'LM Studio' };

/**
 * When the reader is served by scripts/serve.mjs, the model servers of that computer are reachable
 * at this very address under /proxy/<name>. That is the address to use from a phone or a tablet.
 */
function useProxyPresets(): Preset[] {
  const [presets, setPresets] = useState<Preset[]>([]);
  useEffect(() => {
    let alive = true;
    fetch('/proxy/')
      .then((res) => (res.ok && res.headers.get('content-type')?.includes('json') ? res.json() : null))
      .then((data: { proxies?: string[] } | null) => {
        if (!alive || !Array.isArray(data?.proxies)) return;
        setPresets(data.proxies.map((name) => ({ name: `${PROXY_NAMES[name] ?? name} через проксі`, url: `${location.origin}/proxy/${name}/v1` })));
      })
      .catch(() => {
        // Served by something else: there is no proxy to offer.
      });
    return () => {
      alive = false;
    };
  }, []);
  return presets;
}

function LocalSection({ draft, set }: SectionProps) {
  const proxyPresets = useProxyPresets();
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [status, setStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'error'; text?: string }>({ kind: 'idle' });

  /** Tries the usual places for a model server — the app's own proxy first — and fills in the first that answers. */
  const detect = async () => {
    setStatus({ kind: 'busy' });
    for (const preset of [...proxyPresets, ...LOCAL_PRESETS]) {
      if (isBlockedMixedContent(preset.url)) continue;
      try {
        const list = await listLocalModels(preset.url, draft.localApiKey, timeoutSignal(2500));
        if (!list.length) continue;
        setModels(list);
        set({ localBaseUrl: preset.url, localModel: list.some((m) => m.id === draft.localModel) ? draft.localModel : list[0].id });
        setStatus({ kind: 'ok', text: `Знайдено: ${preset.name}. Моделей: ${list.length} — оберіть потрібну нижче.` });
        return;
      } catch {
        // Nothing at this address: try the next one.
      }
    }
    setStatus({ kind: 'error', text: 'Не знайшов сервера моделей ні через проксі застосунку, ні на цьому пристрої. Запустіть Ollama чи LM Studio й спробуйте ще раз.' });
  };

  const refresh = async (url = draft.localBaseUrl) => {
    setStatus({ kind: 'busy' });
    try {
      const list = await listLocalModels(url, draft.localApiKey);
      setModels(list);
      setStatus({ kind: 'ok', text: list.length ? `Знайдено моделей: ${list.length}` : 'Сервер відповідає, але моделей на ньому немає.' });
      if (list.length && !list.some((m) => m.id === draft.localModel)) set({ localModel: list[0].id });
    } catch (err) {
      setModels(null);
      const reason = err instanceof TypeError ? 'сервер не відповідає або не дозволяє запити з цього сайту' : err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'error', text: `Не вдалося отримати список моделей: ${reason}.` });
    }
  };

  return (
    <>
      <div className="field column">
        <span>Адреса сервера (OpenAI-сумісний API)</span>
        <div className="row">
          <input value={draft.localBaseUrl} onChange={(e) => set({ localBaseUrl: e.target.value })} placeholder="http://localhost:11434/v1" inputMode="url" autoCapitalize="none" spellCheck={false} />
          <button className="btn" onClick={() => void refresh()} disabled={status.kind === 'busy'} title="Перевірити з’єднання й отримати список моделей">
            {status.kind === 'busy' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} Перевірити
          </button>
        </div>
        <div className="presets">
          <button className="chip" onClick={() => void detect()} disabled={status.kind === 'busy'} title="Перевірити звичні адреси й заповнити поля самому">
            <Search size={13} /> Знайти автоматично
          </button>
          {[...LOCAL_PRESETS, ...proxyPresets].map((p) => (
            <button
              key={p.name}
              className={cx('chip', draft.localBaseUrl.trim() === p.url && 'active')}
              onClick={() => {
                set({ localBaseUrl: p.url });
                void refresh(p.url);
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
        {status.text && <small className={cx(status.kind === 'error' ? 'error-text' : 'muted')}>{status.text}</small>}
        <MixedContentWarning url={draft.localBaseUrl} />
      </div>

      <label className="field column">
        <span>Модель</span>
        {models?.length ? (
          <select value={draft.localModel} onChange={(e) => set({ localModel: e.target.value })}>
            {!models.some((m) => m.id === draft.localModel) && <option value={draft.localModel}>{draft.localModel || '— оберіть —'}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        ) : (
          <input value={draft.localModel} onChange={(e) => set({ localModel: e.target.value })} placeholder="Назва моделі, як у «ollama list»" spellCheck={false} />
        )}
      </label>

      <CapabilityToggles tools={draft.localTools} vision={draft.localVision} onTools={(localTools) => set({ localTools })} onVision={(localVision) => set({ localVision })} />

      <label className="field column">
        <span>Розмір контексту моделі</span>
        <select value={draft.localContext} onChange={(e) => set({ localContext: e.target.value as ContextSize })}>
          <option value="small">Малий (близько 4K токенів) — читає потроху</option>
          <option value="medium">Середній (8–16K токенів)</option>
          <option value="large">Великий (32K і більше)</option>
        </select>
        <small className="muted">Від цього залежить, скільки тексту книги агент бере за один раз. Якщо модель «забуває» запитання, оберіть менший розмір.</small>
      </label>

      <details className="help">
        <summary>Як підготувати Ollama</summary>
        <ul>
          <li>
            Запустіть Ollama і завантажте модель: <code>ollama pull назва-моделі</code>. Щоб агент сам читав і шукав по книзі, беріть модель із позначкою tools у
            каталозі Ollama.
          </li>
          <li>
            Стандартний контекст Ollama — 4096 токенів, для книг цього мало. Збільште його змінною <code>OLLAMA_CONTEXT_LENGTH=16384</code> перед запуском.
          </li>
          <li>
            Якщо застосунок відкрито не з localhost, дозвольте йому запити: <code>OLLAMA_ORIGINS={location.origin}</code>, потім перезапустіть Ollama.
          </li>
          <li>
            З телефона чи планшета замість localhost вкажіть адресу комп’ютера з моделями. Якщо застосунок відкрито через HTTPS, сервер моделей теж має
            відповідати через HTTPS — найпростіше через проксі з README (<code>npm run serve</code>), тоді адреса буде <code>{location.origin}/proxy/ollama/v1</code>.
          </li>
          <li>Ключ потрібен лише серверам, які його вимагають; для Ollama та LM Studio залиште поле порожнім.</li>
        </ul>
      </details>
      <KeyField label="Ключ (необов’язково)" value={draft.localApiKey} placeholder="зазвичай не потрібен" onChange={(localApiKey) => set({ localApiKey })} />
    </>
  );
}

function EmbeddingSection({ draft, set }: SectionProps) {
  const proxyPresets = useProxyPresets();
  return (
    <details className="help" open={draft.embedBackend === 'server'}>
      <summary>Смисловий пошук: де рахувати ембединги</summary>
      <div className="field column">
        <div className="segmented wide">
          {(
            [
              { id: 'browser', label: 'У браузері' },
              { id: 'server', label: 'На сервері моделей' },
            ] as { id: EmbedBackend; label: string }[]
          ).map((b) => (
            <button key={b.id} className={cx(draft.embedBackend === b.id && 'active')} onClick={() => set({ embedBackend: b.id })}>
              {b.label}
            </button>
          ))}
        </div>
        {draft.embedBackend === 'browser' ? (
          <>
            <input
              value={draft.embedBrowserModel}
              onChange={(e) => set({ embedBrowserModel: e.target.value })}
              placeholder={DEFAULT_BROWSER_MODEL}
              aria-label="Модель ембедингів у браузері"
              autoCapitalize="none"
              spellCheck={false}
            />
            <div className="presets">
              {BROWSER_EMBED_PRESETS.map((p) => (
                <button key={p.id} className={cx('chip', draft.embedBrowserModel.trim() === p.id && 'active')} onClick={() => set({ embedBrowserModel: p.id })}>
                  {p.name}
                </button>
              ))}
            </div>
            <small className="muted">
              Модель працює просто в браузері: під час першого індексування вона завантажується з Hugging Face і далі доступна офлайн, а текст книги нікуди не
              надсилається. Можна вписати id іншої моделі ембедингів з ONNX-вагами. Після зміни моделі індекс книги треба побудувати заново.
            </small>
          </>
        ) : (
          <>
            <input value={draft.embedBaseUrl} onChange={(e) => set({ embedBaseUrl: e.target.value })} placeholder="http://localhost:11434/v1" spellCheck={false} autoCapitalize="none" aria-label="Адреса сервера ембедингів" />
            <MixedContentWarning url={draft.embedBaseUrl} />
            <div className="presets">
              {[...LOCAL_PRESETS, ...proxyPresets, { name: 'OpenRouter', url: OPENROUTER_URL }].map((p) => (
                <button key={p.name} className={cx('chip', draft.embedBaseUrl.trim() === p.url && 'active')} onClick={() => set({ embedBaseUrl: p.url })}>
                  {p.name}
                </button>
              ))}
            </div>
            <input value={draft.embedModel} onChange={(e) => set({ embedModel: e.target.value })} placeholder="Модель ембедингів, напр. bge-m3" spellCheck={false} aria-label="Модель ембедингів" />
            <input
              type="password"
              value={draft.embedApiKey}
              onChange={(e) => set({ embedApiKey: e.target.value })}
              placeholder="Ключ (для Ollama не потрібен)"
              autoComplete="off"
              aria-label="Ключ сервера ембедингів"
            />
            <small className="muted">
              Потрібна модель ембедингів, яка розуміє мову книги (для української — багатомовна, наприклад bge-m3 в Ollama: <code>ollama pull bge-m3</code>). Після
              зміни моделі індекс книги треба побудувати заново.
            </small>
          </>
        )}
      </div>
    </details>
  );
}
