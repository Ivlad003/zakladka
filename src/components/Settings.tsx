import { db } from '../db';
import { Minus, Plus } from 'lucide-react';
import { cx, truncate } from '../lib/utils';
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
/** The text mode of a PDF or DjVu book: whether it is on, and what can be done from the menu. */
export interface TextModeControl {
  on: boolean;
  onChange(on: boolean): void;
  onSaveCopy(): void;
}

export function ViewSettings({ kind, scale, textMode, onClose }: { kind: 'fixed' | 'epub'; scale: number; textMode?: TextModeControl; onClose(): void }) {
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
        <label className="field">
          <span>Дві сторінки поруч</span>
          <Segmented
            value={s.spread}
            options={[
              { id: 'auto', label: 'Широкий екран' },
              { id: 'landscape', label: '+ планшет боком' },
              { id: 'off', label: 'Ні' },
            ]}
            onChange={(spread) => updateSettings({ spread })}
          />
        </label>

        {textMode && (
          <>
            <label className="field">
              <span>Показувати</span>
              <Segmented
                value={textMode.on ? 'text' : 'original'}
                options={[
                  { id: 'original', label: 'Оригінал' },
                  { id: 'text', label: 'Текст' },
                ]}
                onChange={(v) => textMode.onChange(v === 'text')}
              />
            </label>
            <p className="muted small">
              {textMode.on ? (
                <>
                  Текст сторінок, розкладений як в EPUB: шрифт, розмір, інтервал і тема — на ваш смак. Малюнки, таблиці й формули точніші в «Оригіналі».{' '}
                  <button type="button" className="link" onClick={textMode.onSaveCopy}>
                    Зберегти як окрему EPUB-книгу
                  </button>
                </>
              ) : (
                '«Текст» показує текст сторінок як в EPUB — зручно на телефоні: шрифт і розмір на ваш смак, без масштабування.'
              )}
            </p>
          </>
        )}

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
                  ...(s.epubCustomFontName ? [{ id: 'custom' as EpubFont, label: truncate(s.epubCustomFontName, 14) }] : []),
                ]}
                onChange={(epubFont) => updateSettings({ epubFont })}
              />
            </label>
            <FontPicker />
            <label className="field">
              <span>Поля</span>
              <Segmented
                value={s.epubMargins}
                options={[
                  { id: 'narrow', label: 'Вузькі' },
                  { id: 'normal', label: 'Звичайні' },
                  { id: 'wide', label: 'Широкі' },
                ]}
                onChange={(epubMargins) => updateSettings({ epubMargins })}
              />
            </label>
            <label className="field">
              <span>Вирівнювання</span>
              <Segmented
                value={s.epubAlign}
                options={[
                  { id: 'publisher', label: 'Як у книзі' },
                  { id: 'left', label: 'Ліворуч' },
                  { id: 'justify', label: 'По ширині' },
                ]}
                onChange={(epubAlign) => updateSettings({ epubAlign })}
              />
            </label>
            <label className="field">
              <span>Між абзацами</span>
              <Segmented
                value={s.epubParagraphGap}
                options={[
                  { id: 'publisher', label: 'Як у книзі' },
                  { id: 'none', label: 'Без' },
                  { id: 'small', label: 'Трохи' },
                  { id: 'large', label: 'Рядок' },
                ]}
                onChange={(epubParagraphGap) => updateSettings({ epubParagraphGap })}
              />
            </label>
            <label className="field">
              <span>Між літерами</span>
              <Segmented
                value={String(s.epubLetterSpacing)}
                options={[
                  { id: '0', label: 'Звично' },
                  { id: '0.03', label: 'Ширше' },
                  { id: '0.06', label: 'Ще ширше' },
                ]}
                onChange={(v) => updateSettings({ epubLetterSpacing: Number(v) })}
              />
            </label>
            <label className="field checkbox">
              <input type="checkbox" checked={s.epubHyphens} onChange={(e) => updateSettings({ epubHyphens: e.target.checked })} />
              <span>Переносити слова</span>
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

/** Adds the reader's own font (TTF, OTF, WOFF): kept in the database, shown as an option next to the others. */
function FontPicker() {
  const s = useSettings();
  return (
    <label className="field font-picker">
      <span>{s.epubCustomFontName ? 'Свій шрифт' : 'Додати свій шрифт'}</span>
      <span className="btn small">
        {s.epubCustomFontName ? 'Замінити…' : 'Вибрати файл…'}
        <input
          type="file"
          accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            await db.assets.put({ id: 'font', name: file.name, data: file });
            updateSettings({ epubCustomFontName: file.name.replace(/\.[^.]+$/, ''), epubFont: 'custom' });
          }}
        />
      </span>
    </label>
  );
}
