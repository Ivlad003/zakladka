import { useState } from 'react';
import { CircleCheck, Cloud, LoaderCircle, RefreshCw, TriangleAlert, X } from 'lucide-react';
import type { S3Config } from '../lib/s3';
import { syncNow, testConnection, useSyncStatus, type SyncReport } from '../lib/sync';
import { cx, pluralUk } from '../lib/utils';
import { getSettings, updateSettings } from '../settings';

interface Draft {
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Prefix: string;
  syncAuto: boolean;
}

type Check = { kind: 'idle' | 'busy' | 'ok' | 'no-bucket' | 'error'; text?: string };

const isLocalHost = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url.trim());

function describeReport(r: SyncReport): string {
  const parts = [
    r.uploaded && `вивантажено ${r.uploaded} ${pluralUk(r.uploaded, 'книгу', 'книги', 'книг')}`,
    r.downloaded && `додано зі сховища ${r.downloaded}`,
    r.updated && `оновлено нотатки й позиції в ${r.updated}`,
    r.removed && `видалено ${r.removed}`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'змін не було';
}

const formatTime = (at: number) => new Date(at).toLocaleString('uk-UA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/** Cross-device sync through S3-compatible storage such as RustFS. */
export function SyncDialog({ onClose }: { onClose(): void }) {
  const status = useSyncStatus();
  const [draft, setDraft] = useState<Draft>(() => {
    const s = getSettings();
    return { s3Endpoint: s.s3Endpoint, s3Region: s.s3Region, s3Bucket: s.s3Bucket, s3AccessKey: s.s3AccessKey, s3SecretKey: s.s3SecretKey, s3Prefix: s.s3Prefix, syncAuto: s.syncAuto };
  });
  const [check, setCheck] = useState<Check>({ kind: 'idle' });
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setCheck({ kind: 'idle' });
  };

  const complete = Boolean(draft.s3Endpoint.trim() && draft.s3Bucket.trim() && draft.s3AccessKey.trim() && draft.s3SecretKey.trim());
  const config: S3Config = {
    endpoint: draft.s3Endpoint,
    region: draft.s3Region,
    bucket: draft.s3Bucket,
    accessKey: draft.s3AccessKey.trim(),
    secretKey: draft.s3SecretKey.trim(),
    prefix: draft.s3Prefix,
  };
  // Browsers refuse plain-HTTP requests from a page served over HTTPS (except to this very device).
  const mixedContent = location.protocol === 'https:' && /^http:/i.test(draft.s3Endpoint.trim()) && !isLocalHost(draft.s3Endpoint);

  const save = () =>
    updateSettings({
      s3Endpoint: draft.s3Endpoint.trim().replace(/\/+$/, ''),
      s3Region: draft.s3Region.trim() || 'us-east-1',
      s3Bucket: draft.s3Bucket.trim(),
      s3AccessKey: draft.s3AccessKey.trim(),
      s3SecretKey: draft.s3SecretKey.trim(),
      s3Prefix: draft.s3Prefix.trim().replace(/^\/+|\/+$/g, ''),
      syncAuto: draft.syncAuto,
    });

  const test = async (createBucket = false) => {
    setCheck({ kind: 'busy' });
    const result = await testConnection(config, createBucket);
    if (!result.ok) setCheck({ kind: 'error', text: result.error });
    else if (result.bucketExists) setCheck({ kind: 'ok', text: `З’єднання є, бакет «${config.bucket.trim()}» доступний.` });
    else setCheck({ kind: 'no-bucket', text: `З’єднання є, але бакета «${config.bucket.trim()}» ще немає.` });
  };

  const saveAndSync = async () => {
    save();
    await syncNow();
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sync-dialog" role="dialog" aria-label="Синхронізація між пристроями" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="modal-header">
          <h2>
            <Cloud size={18} /> Синхронізація між пристроями
          </h2>
          <button className="icon-btn" onClick={onClose} title="Закрити">
            <X size={18} />
          </button>
        </header>

        <p className="muted small">
          Книги, місце читання, виділення, нотатки, закладки, малюнки та розпізнаний текст зберігаються у вашому S3-сумісному сховищі (RustFS, MinIO тощо) і
          з’являються на всіх пристроях, де вказано ті самі адресу, бакет і ключі.
        </p>

        <label className="field column">
          <span>Адреса сховища (S3 API)</span>
          <input
            value={draft.s3Endpoint}
            onChange={(e) => set({ s3Endpoint: e.target.value })}
            placeholder="https://rustfs.example.com"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <small className="muted">Для RustFS це порт 9000 (не консоль на 9001).</small>
          {mixedContent && (
            <small className="error-text">
              Застосунок відкрито через HTTPS, тож браузер не пустить запити на адресу http://. Відкрийте сховище через HTTPS або заходьте в застосунок через
              http://.
            </small>
          )}
        </label>

        <label className="field column">
          <span>Бакет</span>
          <input value={draft.s3Bucket} onChange={(e) => set({ s3Bucket: e.target.value })} placeholder="zakladka" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </label>

        <div className="field-pair">
          <label className="field column">
            <span>Access Key</span>
            <input value={draft.s3AccessKey} onChange={(e) => set({ s3AccessKey: e.target.value })} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </label>
          <label className="field column">
            <span>Secret Key</span>
            <input type="password" value={draft.s3SecretKey} onChange={(e) => set({ s3SecretKey: e.target.value })} autoComplete="off" />
          </label>
        </div>

        <details className="help">
          <summary>Додатково: регіон і папка</summary>
          <div className="field-pair">
            <label className="field column">
              <span>Регіон</span>
              <input value={draft.s3Region} onChange={(e) => set({ s3Region: e.target.value })} placeholder="us-east-1" autoCapitalize="none" spellCheck={false} />
            </label>
            <label className="field column">
              <span>Папка в бакеті</span>
              <input value={draft.s3Prefix} onChange={(e) => set({ s3Prefix: e.target.value })} placeholder="не обов’язково" autoCapitalize="none" spellCheck={false} />
            </label>
          </div>
        </details>

        <label className="field checkbox">
          <input type="checkbox" checked={draft.syncAuto} onChange={(e) => set({ syncAuto: e.target.checked })} />
          <span>Синхронізувати автоматично: під час запуску, після закриття книги та кожні 5 хвилин</span>
        </label>

        {check.text && (
          <p className={cx('sync-line', check.kind === 'error' && 'error-text')}>
            {check.kind === 'error' ? <TriangleAlert size={15} /> : <CircleCheck size={15} />}
            <span>{check.text}</span>
            {check.kind === 'no-bucket' && (
              <button className="btn small" onClick={() => void test(true)}>
                Створити бакет
              </button>
            )}
          </p>
        )}

        {status.running ? (
          <p className="sync-line">
            <LoaderCircle size={15} className="spin" />
            <span>{status.step}</span>
          </p>
        ) : status.error ? (
          <p className="sync-line error-text">
            <TriangleAlert size={15} />
            <span>{status.error}</span>
          </p>
        ) : (
          status.lastSyncAt && (
            <p className="sync-line muted">
              <CircleCheck size={15} />
              <span>
                Остання синхронізація: {formatTime(status.lastSyncAt)}
                {status.lastReport && ` — ${describeReport(status.lastReport)}`}.
              </span>
            </p>
          )
        )}

        <details className="help">
          <summary>Як підготувати RustFS</summary>
          <ul>
            <li>
              Запустіть RustFS, наприклад у Docker: <code>docker run -d -p 9000:9000 -p 9001:9001 -v rustfs-data:/data rustfs/rustfs</code>. S3 API працює на
              порту 9000, вебконсоль — на 9001.
            </li>
            <li>
              Дозвольте запити з цього сайту змінною <code>RUSTFS_CORS_ALLOWED_ORIGINS={location.origin}</code> (кілька адрес — через кому) і перезапустіть
              RustFS. Без цього браузер блокує з’єднання.
            </li>
            <li>У консолі RustFS створіть ключ доступу (Access Key і Secret Key) і введіть його тут. Натисніть «Перевірити»: якщо бакета ще немає, його можна буде створити звідси.</li>
            <li>
              Щоб синхронізація працювала на телефоні чи планшеті поза домашньою мережею, сховище має бути доступне за адресою https://, наприклад через
              Tailscale або зворотний проксі з сертифікатом.
            </li>
          </ul>
        </details>

        <p className="muted small">
          Ключі зберігаються лише в цьому браузері. Ключі AI, розмови з агентами та індекси смислового пошуку не синхронізуються. Якщо ту саму нотатку змінено на
          двох пристроях, залишається новіша версія.
        </p>

        <footer className="modal-footer">
          <button className="btn" onClick={() => void test()} disabled={!complete || check.kind === 'busy'}>
            {check.kind === 'busy' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} Перевірити
          </button>
          <span className="spacer" />
          <button
            className="btn"
            onClick={() => {
              save();
              onClose();
            }}
          >
            Зберегти
          </button>
          <button className="btn primary" onClick={() => void saveAndSync()} disabled={!complete || status.running}>
            Синхронізувати
          </button>
        </footer>
      </div>
    </div>
  );
}
