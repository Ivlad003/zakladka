import { useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { applyUpdate, useUpdateState } from '../lib/update';
import { appVersion } from '../lib/version';

/**
 * Says that a new version is waiting (it installs itself as soon as the reader pauses) and offers
 * to switch right away; after an update, confirms it briefly so the reload is not a mystery.
 */
export function UpdateToast() {
  const state = useUpdateState();
  const [dismissed, setDismissed] = useState(false);

  if (state === 'applied') {
    return (
      <div className="update-toast" role="status">
        <RefreshCw size={15} /> Застосунок оновлено до версії {appVersion}
      </div>
    );
  }
  if (state !== 'ready' || dismissed) return null;
  return (
    <div className="update-toast" role="status">
      <span>Є нова версія — оновиться сама, щойно ви зробите паузу.</span>
      <button className="btn small primary" onClick={applyUpdate}>
        Оновити зараз
      </button>
      <button className="icon-btn" onClick={() => setDismissed(true)} title="Сховати" aria-label="Сховати">
        <X size={16} />
      </button>
    </div>
  );
}
