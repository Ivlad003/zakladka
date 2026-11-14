import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, BookCheck, Flame, Minus, Plus, Target, Timer } from 'lucide-react';
import { db } from '../db';
import { dayKey, durationLabel, finishedThisYear, lastDays, paceOf, streaks, useReadingLog, type DayTotal } from '../lib/stats';
import { pluralUk, truncate } from '../lib/utils';
import { updateSettings, useSettings } from '../settings';

const weekday = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString('uk-UA', { weekday: 'short' });
const dateLabel = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });

/** Minutes read per day over the last 30 days: one series, so one colour and no legend; the goal is a reference line. */
function DaysChart({ days, goalMinutes }: { days: DayTotal[]; goalMinutes: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(goalMinutes, ...days.map((d) => d.seconds / 60), 10);
  const W = 600;
  const H = 160;
  const top = 10;
  const bottom = 22;
  const plot = H - top - bottom;
  const step = W / days.length;
  const bar = Math.max(4, step - 2); // a 2px gap between neighbours
  const y = (minutes: number) => top + plot - (minutes / max) * plot;
  const shown = hover ?? days.length - 1;
  const focus = days[shown];
  return (
    <div className="days-chart">
      <div className="chart-readout" aria-live="polite">
        <strong>{focus.seconds ? durationLabel(focus.seconds) : '0 хв'}</strong>
        <span className="muted">
          {shown === days.length - 1 ? 'сьогодні' : `${weekday(focus.day)}, ${dateLabel(focus.day)}`}
          {focus.pages ? ` · ${focus.pages} стор.` : ''}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Хвилини читання за останні 30 днів" onPointerLeave={() => setHover(null)}>
        <line className="chart-axis" x1={0} x2={W} y1={top + plot + 0.5} y2={top + plot + 0.5} />
        {goalMinutes > 0 && (
          <g className="chart-goal">
            <line x1={0} x2={W} y1={y(goalMinutes)} y2={y(goalMinutes)} />
            <text x={W - 2} y={y(goalMinutes) - 4} textAnchor="end">
              ціль {goalMinutes} хв
            </text>
          </g>
        )}
        {days.map((d, i) => {
          const minutes = d.seconds / 60;
          const h = minutes > 0 ? Math.max(3, (minutes / max) * plot) : 0;
          const x = i * step + (step - bar) / 2;
          const r = Math.min(4, bar / 2, h);
          // Rounded only at the data end, anchored square to the baseline.
          const path = h
            ? `M${x},${top + plot} V${top + plot - h + r} Q${x},${top + plot - h} ${x + r},${top + plot - h} H${x + bar - r} Q${x + bar},${top + plot - h} ${x + bar},${top + plot - h + r} V${top + plot} Z`
            : '';
          return (
            <g key={d.day}>
              {path && <path className={i === shown ? 'chart-bar active' : 'chart-bar'} d={path} />}
              {/* The hit target is the whole column, wider and taller than the bar. */}
              <rect x={i * step} y={top} width={step} height={plot + bottom} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
            </g>
          );
        })}
        {[0, 7, 14, 21, days.length - 1].map((i) => (
          // The first and last labels hang inwards, so they are not cut off at the edges.
          <text key={i} className="chart-tick" x={i === 0 ? 0 : i === days.length - 1 ? W : i * step + step / 2} y={H - 6} textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}>
            {i === days.length - 1 ? 'сьогодні' : dateLabel(days[i].day)}
          </text>
        ))}
      </svg>
      <details className="chart-table">
        <summary>Таблицею</summary>
        <table>
          <thead>
            <tr>
              <th>День</th>
              <th>Час</th>
              <th>Сторінки</th>
            </tr>
          </thead>
          <tbody>
            {[...days].reverse().map((d) => (
              <tr key={d.day}>
                <td>
                  {weekday(d.day)}, {dateLabel(d.day)}
                </td>
                <td>{d.seconds ? durationLabel(d.seconds) : '—'}</td>
                <td>{d.pages || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** Reading statistics: today, the streak, the last 30 days, the year's goal, each book. */
export function Stats() {
  const settings = useSettings();
  const log = useReadingLog();
  const books = useLiveQuery(() => db.books.toArray(), []);
  const now = Date.now();
  const rows = log ?? [];
  const days = useMemo(() => lastDays(rows, 30, now), [rows, now]);
  const today = days[days.length - 1];
  const week = days.slice(-7).reduce((n, d) => n + d.seconds, 0);
  const streak = useMemo(() => streaks(rows, now), [rows, now]);
  const finished = finishedThisYear(books ?? [], now);
  const goal = settings.yearGoal;
  const year = new Date(now).getFullYear();
  const yearSeconds = rows.filter((r) => r.day.startsWith(String(year))).reduce((n, r) => n + r.seconds, 0);

  const perBook = useMemo(() => {
    const byBook = new Map<string, number>();
    for (const r of rows) byBook.set(r.bookId, (byBook.get(r.bookId) ?? 0) + r.seconds);
    return [...byBook]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => ({ book: books?.find((b) => b.id === id), pace: paceOf(rows, id) }))
      .filter((x) => x.book);
  }, [rows, books]);

  return (
    <div className="library study stats">
      <header className="library-bar">
        <button className="icon-btn" onClick={() => (location.hash = '')} title="До бібліотеки" aria-label="До бібліотеки">
          <ArrowLeft size={20} />
        </button>
        <div className="brand">
          <div>
            <strong>Статистика</strong>
            <small className="muted">час читання, серії, цілі</small>
          </div>
        </div>
      </header>
      <main className="library-main study-main">
        <section className="stat-tiles">
          <div className="stat-tile">
            <Timer size={18} />
            <strong>{today.seconds ? durationLabel(today.seconds) : '0 хв'}</strong>
            <span className="muted">сьогодні{today.pages ? ` · ${today.pages} стор.` : ''}</span>
            {settings.dailyGoal > 0 && (
              <div className="goal-bar" aria-label={`Денна ціль: ${settings.dailyGoal} хв`}>
                <div style={{ width: `${Math.min(100, (today.seconds / 60 / settings.dailyGoal) * 100)}%` }} />
              </div>
            )}
          </div>
          <div className="stat-tile">
            <Flame size={18} />
            <strong>
              {streak.current} {pluralUk(streak.current, 'день', 'дні', 'днів')}
            </strong>
            <span className="muted">поспіль · найдовше {streak.longest}</span>
          </div>
          <div className="stat-tile">
            <BookCheck size={18} />
            <strong>
              {finished.length} з {goal}
            </strong>
            <span className="muted">книг у {year} році</span>
            <div className="goal-bar">
              <div style={{ width: `${Math.min(100, (finished.length / Math.max(1, goal)) * 100)}%` }} />
            </div>
          </div>
          <div className="stat-tile">
            <Target size={18} />
            <strong>{week ? durationLabel(week) : '0 хв'}</strong>
            <span className="muted">за 7 днів · за рік {yearSeconds ? durationLabel(yearSeconds) : '0 хв'}</span>
          </div>
        </section>

        <section className="study-section">
          <div className="study-head">
            <h2>Останні 30 днів</h2>
          </div>
          <DaysChart days={days} goalMinutes={settings.dailyGoal} />
        </section>

        <section className="study-section">
          <div className="study-head">
            <h2>Цілі</h2>
          </div>
          <div className="field">
            <span>Книг за рік</span>
            <div className="stepper">
              <button className="icon-btn" onClick={() => updateSettings({ yearGoal: Math.max(1, goal - 1) })} aria-label="Менше">
                <Minus size={16} />
              </button>
              <span>{goal}</span>
              <button className="icon-btn" onClick={() => updateSettings({ yearGoal: goal + 1 })} aria-label="Більше">
                <Plus size={16} />
              </button>
            </div>
          </div>
          <div className="field">
            <span>Хвилин на день</span>
            <div className="segmented">
              {[0, 10, 20, 30, 60].map((m) => (
                <button key={m} className={settings.dailyGoal === m ? 'active' : ''} onClick={() => updateSettings({ dailyGoal: m })}>
                  {m || 'без'}
                </button>
              ))}
            </div>
          </div>
          <p className="muted small">
            Книга вважається прочитаною, коли ви дійшли до кінця; позначити вручну можна олівцем на картці книги. Час рахується, поки книга на екрані і ви щось робите —
            після трьох хвилин без дій лічильник зупиняється.
          </p>
        </section>

        {finished.length > 0 && (
          <section className="study-section">
            <div className="study-head">
              <h2>Прочитано у {year}</h2>
            </div>
            <ul className="stats-books">
              {finished.map((b) => (
                <li key={b.id}>
                  <strong>{truncate(b.title, 60)}</strong>
                  <span className="muted">
                    {b.author ? `${b.author} · ` : ''}
                    {dateLabel(dayKey(b.finishedAt!))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {perBook.length > 0 && (
          <section className="study-section">
            <div className="study-head">
              <h2>Книги</h2>
            </div>
            <ul className="stats-books">
              {perBook.map(({ book, pace }) => {
                const left = pace.progressPerSecond && book!.progress < 1 ? (1 - book!.progress) / pace.progressPerSecond : null;
                return (
                  <li key={book!.id}>
                    <strong>{truncate(book!.title, 60)}</strong>
                    <span className="muted">
                      {durationLabel(pace.seconds)} · {pace.pages} стор. · {Math.round(book!.progress * 100)}%
                      {pace.secondsPerPage ? ` · ${Math.round(3600 / pace.secondsPerPage)} стор./год` : ''}
                      {left ? ` · лишилося ≈${durationLabel(left)}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {log && !rows.length && <p className="muted center">Ще немає даних: відкрийте книгу й почитайте — статистика з’явиться тут.</p>}
      </main>
    </div>
  );
}
