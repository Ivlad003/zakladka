import { Minus, Plus } from 'lucide-react';
import { cx } from '../lib/utils';
import { updateSettings, useSettings, type EpubFont, type Theme, type TurnExtra } from '../settings';

const THEMES: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Світла' },
  { id: 'sepia', label: 'Сепія' },
  { id: 'dark', label: 'Темна' },
];

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.id} className={cx(value === o.id && 'active')} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Stepper({ label, onMinus, onPlus }: { label: string; onMinus(): void; onPlus(): void }) {
  return (
    <div className="stepper">
      <button className="icon-btn" onClick={onMinus} aria-label="Менше">
        <Minus size={16} />
      </button>
      <span>{label}</span>
      <button className="icon-btn" onClick={onPlus} aria-label="Більше">
        <Plus size={16} />
      </button>
    </div>
  );
}

const TURN_EXTRAS: { id: TurnExtra; label: string }[] = [
  { id: 'menu', label: 'Меню' },
  { id: 'bookmark', label: 'Закладка' },
  { id: 'toc', label: 'Зміст' },
  { id: 'ai', label: 'AI' },
];

/** How pages are turned: any mix of swipes, taps on the edges and a floating group of buttons. */
function TurningSettings() {
  const s = useSettings();
  const toggleExtra = (id: TurnExtra) =>
    updateSettings({ turnButtonsExtra: s.turnButtonsExtra.includes(id) ? s.turnButtonsExtra.filter((x) => x !== id) : [...s.turnButtonsExtra, id] });
  return (
    <>
      <div className="field column">
        <span>Гортання</span>
        <label className="field checkbox">
          <input type="checkbox" checked={s.turnSwipe} onChange={(e) => updateSettings({ turnSwipe: e.target.checked })} />
          <span>Свайпом</span>
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={s.turnSwipe2} onChange={(e) => updateSettings({ turnSwipe2: e.target.checked })} />
          <span>Свайпом двома пальцями (будь-де на сторінці)</span>
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={s.turnTap} onChange={(e) => updateSettings({ turnTap: e.target.checked })} />
          <span>Дотиком до лівого чи правого краю</span>
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={s.turnZone} onChange={(e) => updateSettings({ turnZone: e.target.checked })} />
          <span>Смугою для свайпу внизу та вздовж країв екрана</span>
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={s.turnButtons} onChange={(e) => updateSettings({ turnButtons: e.target.checked })} />
          <span>Плаваючими кнопками (їх можна перетягувати)</span>
        </label>
      </div>
      {s.turnButtons && (
        <>
          <div className="field">
            <span>Розмір кнопок</span>
            <Segmented
              value={s.turnButtonsSize}
              options={[
                { id: 'small', label: 'Малі' },
                { id: 'medium', label: 'Середні' },
                { id: 'large', label: 'Великі' },
              ]}
              onChange={(turnButtonsSize) => updateSettings({ turnButtonsSize })}
            />
          </div>
          <div className="field">
            <span>Розташування</span>
            <Segmented
              value={s.turnButtonsVertical ? 'v' : 'h'}
              options={[
                { id: 'h', label: 'У рядок' },
                { id: 'v', label: 'Стовпчиком' },
              ]}
              onChange={(v) => updateSettings({ turnButtonsVertical: v === 'v' })}
            />
          </div>
          <div className="field column">
            <span>Додаткові кнопки</span>
            <div className="presets">
              {TURN_EXTRAS.map((extra) => (
                <button key={extra.id} className={cx('chip', s.turnButtonsExtra.includes(extra.id) && 'active')} onClick={() => toggleExtra(extra.id)}>
                  {extra.label}
                </button>
              ))}
              {s.turnButtonsPos && (
                <button className="link" onClick={() => updateSettings({ turnButtonsPos: null })}>
                  Повернути на місце
                </button>
              )}
            </div>
          </div>
        </>
      )}
      <label className="field checkbox">
        <input type="checkbox" checked={s.gestureDebug} onChange={(e) => updateSettings({ gestureDebug: e.target.checked })} />
        <span>Показувати, що бачить застосунок під час дотиків</span>
      </label>
    </>
  );
}

/** Reading appearance popover ("Aa"). `scale` is the effective zoom of a PDF/DjVu view. */
export function ViewSettings({ kind, scale, onClose }: { kind: 'fixed' | 'epub'; scale: number; onClose(): void }) {
  const s = useSettings();
  const zoomBy = (factor: number) => updateSettings({ fixedZoom: Math.min(6, Math.max(0.25, Math.round(scale * factor * 100) / 100)) });

  return (
    <>
      <div className="popover-backdrop" onPointerDown={onClose} />
      <div className="popover view-settings" role="dialog" aria-label="Вигляд">
        <label className="field">
          <span>Тема</span>
          <Segmented value={s.theme} options={THEMES} onChange={(theme) => updateSettings({ theme })} />
        </label>

        {kind === 'epub' ? (
          <>
            <label className="field">
              <span>Розмір шрифту</span>
              <Stepper
                label={`${s.epubFontSize}%`}
                onMinus={() => updateSettings({ epubFontSize: Math.max(70, s.epubFontSize - 10) })}
                onPlus={() => updateSettings({ epubFontSize: Math.min(220, s.epubFontSize + 10) })}
              />
            </label>
            <label className="field">
              <span>Шрифт</span>
              <Segmented<EpubFont>
                value={s.epubFont}
                options={[
                  { id: 'publisher', label: 'Книги' },
                  { id: 'serif', label: 'Із зарубками' },
                  { id: 'sans', label: 'Без зарубок' },
                ]}
                onChange={(epubFont) => updateSettings({ epubFont })}
              />
            </label>
            <label className="field">
              <span>Міжрядковий інтервал</span>
              <Stepper
                label={s.epubLineHeight.toFixed(1)}
                onMinus={() => updateSettings({ epubLineHeight: Math.max(1.1, Math.round((s.epubLineHeight - 0.1) * 10) / 10) })}
                onPlus={() => updateSettings({ epubLineHeight: Math.min(2.4, Math.round((s.epubLineHeight + 0.1) * 10) / 10) })}
              />
            </label>
            <label className="field">
              <span>Режим</span>
              <Segmented
                value={s.epubFlow}
                options={[
                  { id: 'paginated', label: 'Сторінки' },
                  { id: 'scrolled', label: 'Прокрутка' },
                ]}
                onChange={(epubFlow) => updateSettings({ epubFlow })}
              />
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span>Масштаб</span>
              <Stepper label={`${Math.round(scale * 100)}%`} onMinus={() => zoomBy(1 / 1.15)} onPlus={() => zoomBy(1.15)} />
            </label>
            <label className="field">
              <span>Режим</span>
              <Segmented
                value={s.fixedFlow}
                options={[
                  { id: 'paged', label: 'Сторінки' },
                  { id: 'scrolled', label: 'Прокрутка' },
                ]}
                onChange={(fixedFlow) => updateSettings({ fixedFlow })}
              />
            </label>
            <div className="field">
              <span>Вписати</span>
              <div className="segmented">
                <button className={cx(s.fixedZoom === 'fit-width' && 'active')} onClick={() => updateSettings({ fixedZoom: 'fit-width' })}>
                  За шириною
                </button>
                <button className={cx(s.fixedZoom === 'fit-page' && 'active')} onClick={() => updateSettings({ fixedZoom: 'fit-page' })}>
                  Сторінку
                </button>
                <button className={cx(s.fixedZoom === 1 && 'active')} onClick={() => updateSettings({ fixedZoom: 1 })}>
                  100%
                </button>
              </div>
            </div>
            <label className="field checkbox">
              <input type="checkbox" checked={s.invertInDark} onChange={(e) => updateSettings({ invertInDark: e.target.checked })} />
              <span>Затемнювати сторінки в темній темі</span>
            </label>
          </>
        )}
        <TurningSettings />
      </div>
    </>
  );
}
