import { useState } from 'react';
import { applyUpdate, checkForUpdate } from '../lib/update';
import { appVersion, buildCommit, buildTime } from '../lib/version';
import { cx } from '../lib/utils';

/** Which build this device runs, and a way to look for a newer one without waiting for the next automatic check. */
export function AppVersion({ className }: { className?: string }) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'ready' | 'latest' | 'offline' | 'unsupported'>('idle');
  const made = buildTime().toLocaleString('uk-UA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const check = async () => {
    setStatus('checking');
    const found = await checkForUpdate();
    setStatus(found);
    // The reader asked for it, so there is no need to wait for a pause.
    if (found === 'ready') setTimeout(applyUpdate, 900);
  };
  const said = {
    idle: '',
    checking: 'Перевіряю…',
    ready: 'Знайдено новішу версію — оновлюю…',
    latest: 'Це найновіша версія.',
    offline: 'Немає зв’язку із сервером застосунку.',
    unsupported: 'У цьому режимі застосунок не оновлюється сам (потрібна зібрана версія, відкрита через сервер).',
  }[status];
  // The "+" stands for files changed after the commit the build is numbered by.
  const origin = buildCommit ? `Коміт ${buildCommit}${appVersion.endsWith('+') ? ' і зміни, яких ще немає в жодному коміті' : ''}` : undefined;
  return (
    <p className={cx('muted small app-version', className)}>
      Версія{' '}
      <strong className="app-version-number" title={origin}>
        {appVersion}
      </strong>
      {buildCommit && <> ({buildCommit})</>} від {made}.{' '}
      <button type="button" className="link" onClick={() => void check()} disabled={status === 'checking'}>
        Перевірити оновлення
      </button>
      {said && <> — {said}</>}
    </p>
  );
}
