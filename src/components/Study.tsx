import { DEFAULT_INITIAL_STABILITY } from '../lib/fsrs';
import { applyFit, MIN_SAMPLES, refitSchedule, storedFit, type ScheduleFit } from '../lib/fsrs-fit';
import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, BookOpen, Brain, ChevronDown, ChevronUp, Flame, Footprints, Landmark, LoaderCircle, MapPin, Pencil, Play, Plus, Sparkles, Target, Trash2 } from 'lucide-react';
import { db } from '../db';
import { setJump } from '../lib/jump';
import {
  countCards,
  createPalace,
  createTopic,
  deletePalace,
  deleteTopic,
  isDue,
  newAllowance,
  PALACE_TEMPLATES,
  placeInOrder,
  savePalace,
  studyStats,
  updateTopic,
  type StudyStats,
} from '../lib/study';
import { DAY } from '../lib/fsrs';
import { cx, pluralUk, truncate, uid } from '../lib/utils';
import { getSettings, updateSettings, useSettings } from '../settings';
import type { BookRecord, MemoryPalace, StudyCard, StudyTopic } from '../types';
import { CardEditor } from './CardEditor';
import { appendSpoken, MicButton } from './MicButton';
import { StudyReview } from './StudyReview';

interface Props {
  /** The address after `#/`: study, study/topic/<id>, study/palace/<id>, review, review/topic/<id>, review/palace/<id>. */
  route: string;
  onOpenBook(bookId: string): void;
}

const go = (hash: string) => {
  location.hash = hash;
};
const COACH = 'coach';
const cardsWord = (n: number) => pluralUk(n, 'картка', 'картки', 'карток');

function useNow(every = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

/** The study room: what to review today, the topics being learnt, and the memory palaces. */
export function Study({ route, onOpenBook }: Props) {
  const topics = useLiveQuery(() => db.topics.orderBy('id').toArray(), []);
  const cards = useLiveQuery(() => db.cards.toArray(), []);
  const palaces = useLiveQuery(() => db.palaces.toArray(), []);
  const books = useLiveQuery(() => db.books.toArray(), []);
  const [screen, kind, id] = route.replace(/^#\//, '').split('/').map(decodeURIComponent);

  if (!topics || !cards || !palaces || !books) {
    return (
      <div className="reader-state">
        <LoaderCircle size={28} className="spin" />
      </div>
    );
  }
  const topic = kind === 'topic' ? topics.find((t) => t.id === id) : undefined;
  const palace = kind === 'palace' ? palaces.find((p) => p.id === id) : undefined;

  if (screen === 'review') {
    const scope = topic ? cards.filter((c) => c.topicId === topic.id) : palace ? cards.filter((c) => c.palaceId === palace.id) : cards;
    const back = topic ? `#/study/topic/${topic.id}` : palace ? `#/study/palace/${palace.id}` : '#/study';
    // Keyed by the address, so each session builds its own queue.
    return <StudyReview key={route} allCards={cards} cards={scope} topics={topics} palaces={palaces} walk={palace} onExit={() => go(back)} onOpenBook={onOpenBook} />;
  }
  if (topic) return <TopicView key={topic.id} topic={topic} cards={cards.filter((c) => c.topicId === topic.id)} allCards={cards} palaces={palaces} books={books} onOpenBook={onOpenBook} />;
  if (palace) return <PalaceView key={palace.id} palace={palace} cards={cards.filter((c) => c.palaceId === palace.id)} />;
  return <StudyHome topics={topics} cards={cards} palaces={palaces} books={books} />;
}

// ---------- Home ----------

function StudyHome({ topics, cards, palaces, books }: { topics: StudyTopic[]; cards: StudyCard[]; palaces: MemoryPalace[]; books: BookRecord[] }) {
  const settings = useSettings();
  const now = useNow();
  const [stats, setStats] = useState<StudyStats | null>(null);
  const counts = countCards(cards, now);
  const fresh = Math.min(counts.fresh, newAllowance(cards, now));
  const todo = counts.due + fresh;

  const [fit, setFit] = useState<ScheduleFit | null>(storedFit);

  useEffect(() => {
    void studyStats().then(setStats);
    // Every answer is evidence; the first intervals are fitted again whenever the cards change.
    void refitSchedule(getSettings().studyPersonal).then(setFit);
  }, [cards]);

  const addTopic = async () => {
    const topic = await createTopic({ title: 'Нова тема' });
    go(`#/study/topic/${topic.id}`);
  };
  const addPalace = async () => {
    const palace = await createPalace('Новий палац', []);
    go(`#/study/palace/${palace.id}`);
  };
  const sorted = [...topics].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="library study">
      <header className="library-bar">
        <button className="icon-btn" onClick={() => go('')} title="До бібліотеки" aria-label="До бібліотеки">
          <ArrowLeft size={20} />
        </button>
        <div className="brand">
          <div>
            <strong>Навчання</strong>
            <small className="muted">повторення за розкладом і палаци пам’яті</small>
          </div>
        </div>
      </header>

      <main className="library-main study-main">
        <section className="study-today">
          <div className="study-count">
            <strong>{todo}</strong>
            <span>
              {cardsWord(todo)} на сьогодні
              <small className="muted">
                {counts.due} до повторення · {fresh} нових
              </small>
            </span>
          </div>
          <button className="btn primary large" onClick={() => go('#/review')} disabled={!todo}>
            <Play size={18} /> Почати
          </button>
          {stats && (
            <div className="study-stats">
              <span title="Днів поспіль із повтореннями">
                <Flame size={15} /> {stats.streak} {pluralUk(stats.streak, 'день', 'дні', 'днів')} поспіль
              </span>
              <span title="Частка карток, які ви згадали, серед повторень за останні 30 днів">
                <Target size={15} /> {stats.retention === null ? 'ще мало даних' : `пригадано ${Math.round(stats.retention * 100)}%`}
              </span>
              <span>сьогодні: {stats.reviewedToday}</span>
            </div>
          )}
        </section>

        <section className="study-section">
          <div className="study-head">
            <h2>Теми</h2>
            <button className="btn small" onClick={() => void addTopic()}>
              <Plus size={15} /> Нова тема
            </button>
          </div>
          {!sorted.length && (
            <p className="panel-empty">
              Тема — це те, що ви хочете вивчити: книга, розділ чи будь-що своє. Створіть тему тут або відкрийте книгу й попросіть агента «Тренер пам’яті» зробити картки з розділу — тема
              з’явиться сама.
            </p>
          )}
          <ul className="study-list">
            {sorted.map((topic) => {
              const own = countCards(
                cards.filter((c) => c.topicId === topic.id),
                now,
              );
              const book = books.find((b) => b.id === topic.bookId);
              return (
                <li key={topic.id}>
                  <button className="study-row" onClick={() => go(`#/study/topic/${topic.id}`)}>
                    <Brain size={18} />
                    <span className="study-row-main">
                      <strong>{topic.title}</strong>
                      <small className="muted">{book ? book.title : 'без книги'}</small>
                    </span>
                    {own.due > 0 && <span className="pill due">{own.due}</span>}
                    {own.fresh > 0 && <span className="pill fresh">{own.fresh} нових</span>}
                    <span className="pill">{own.total}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="study-section">
          <div className="study-head">
            <h2>Палаци пам’яті</h2>
            <button className="btn small" onClick={() => void addPalace()}>
              <Plus size={15} /> Новий палац
            </button>
          </div>
          {!palaces.length && (
            <p className="panel-empty">
              Палац пам’яті — добре знайомий маршрут (квартира, дорога на роботу). На його зупинках ви подумки залишаєте яскраві образи того, що хочете запам’ятати, а потім проходите маршрут
              і «збираєте» їх.
            </p>
          )}
          <ul className="study-list">
            {palaces.map((palace) => {
              const placed = cards.filter((c) => c.palaceId === palace.id).length;
              return (
                <li key={palace.id}>
                  <button className="study-row" onClick={() => go(`#/study/palace/${palace.id}`)}>
                    <Landmark size={18} />
                    <span className="study-row-main">
                      <strong>{palace.name}</strong>
                      <small className="muted">
                        {palace.loci.length} {pluralUk(palace.loci.length, 'місце', 'місця', 'місць')} · розкладено {placed}
                      </small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="study-section">
          <div className="study-head">
            <h2>Налаштування</h2>
          </div>
          <div className="field">
            <span>Скільки хочете пам’ятати на момент повторення</span>
            <div className="segmented">
              {[0.8, 0.85, 0.9, 0.95].map((r) => (
                <button key={r} className={cx(settings.studyRetention === r && 'active')} onClick={() => updateSettings({ studyRetention: r })}>
                  {Math.round(r * 100)}%
                </button>
              ))}
            </div>
          </div>
          <p className="muted small">Вищий відсоток — частіші повторення. 90% — звичний баланс між надійністю й часом.</p>
          <label className="field">
            <span>Підлаштовувати розклад під мої відповіді</span>
            <input
              type="checkbox"
              checked={settings.studyPersonal}
              onChange={(e) => {
                updateSettings({ studyPersonal: e.target.checked });
                applyFit(fit, e.target.checked);
              }}
            />
          </label>
          <p className="muted small">{fitSummary(fit, settings.studyPersonal)}</p>
          <div className="field">
            <span>Нових карток на день</span>
            <div className="segmented">
              {[5, 10, 15, 25, 40].map((n) => (
                <button key={n} className={cx(settings.studyNewPerDay === n && 'active')} onClick={() => updateSettings({ studyNewPerDay: n })}>
                  {n}
                </button>
              ))}
            </div>
          </div>
        </section>

        <Evidence />
      </main>
    </div>
  );
}

/** What the method rests on, with the studies behind each part. */
function Evidence() {
  return (
    <details className="help study-evidence">
      <summary>На чому це ґрунтується</summary>
      <ul>
        <li>
          <strong>Пригадування замість перечитування.</strong> Спроба згадати зміцнює пам’ять сильніше, ніж повторне читання. <em>Roediger &amp; Karpicke, 2006, Psychological Science; Karpicke
          &amp; Blunt, 2011, Science.</em> Тому все тут подано як запитання, а відповідь схована.
        </li>
        <li>
          <strong>Повторення з інтервалами.</strong> Розподілені в часі повторення дають тривкішу пам’ять, ніж зубріння за раз. <em>Ebbinghaus, 1885; Cepeda et al., 2006, Psychological Bulletin.</em>{' '}
          Дати повторень рахує алгоритм FSRS-5 — модель складності, стабільності й імовірності пригадування, параметри якої автори підібрали на великому масиві реальних повторень.{' '}
          <em>Ye, Su &amp; Cao, 2022, KDD.</em>
        </li>
        <li>
          <strong>Метод місць (палац пам’яті).</strong> Шість тижнів тренування методу помітно підвищили обсяг запам’ятовування у звичайних людей, а ефект зберігався через місяці.{' '}
          <em>Dresler et al., 2017, Neuron; Wagner et al., 2021, Science Advances.</em>
        </li>
        <li>
          <strong>Питання до читання.</strong> Спроба відповісти ще до знайомства з матеріалом — навіть невдала — покращує його засвоєння. <em>Richland, Kornell &amp; Kao, 2009, Journal of
          Experimental Psychology: Applied.</em>
        </li>
        <li>
          <strong>Чергування тем.</strong> Перемішані теми в одній сесії запам’ятовуються краще, ніж блоки з однієї теми. <em>Rohrer &amp; Taylor, 2007, Instructional Science.</em> Черга
          повторень перемішує картки з усіх тем.
        </li>
        <li>
          <strong>Що працює найкраще загалом.</strong> Огляд десяти технік навчання: найвищу користь мають самоперевірка й розподілена практика; виділення й перечитування — низьку.{' '}
          <em>Dunlosky et al., 2013, Psychological Science in the Public Interest.</em>
        </li>
      </ul>
    </details>
  );
}

// ---------- One topic ----------

function dueLabel(card: StudyCard, now: number): string {
  if (card.state === 'new') return 'нова';
  if (card.due <= now) return 'час повторити';
  const days = Math.ceil((card.due - now) / DAY);
  return days <= 1 ? 'завтра' : `через ${days} д`;
}

function TopicView({
  topic,
  cards,
  allCards,
  palaces,
  books,
  onOpenBook,
}: {
  topic: StudyTopic;
  cards: StudyCard[];
  allCards: StudyCard[];
  palaces: MemoryPalace[];
  books: BookRecord[];
  onOpenBook(bookId: string): void;
}) {
  const now = useNow();
  const [title, setTitle] = useState(topic.title);
  const [scope, setScope] = useState(topic.scope ?? '');
  const [recall, setRecall] = useState(topic.recall ?? '');
  const [editing, setEditing] = useState<StudyCard | 'new' | null>(null);
  const [palaceId, setPalaceId] = useState(() => cards.find((c) => c.palaceId)?.palaceId ?? palaces[0]?.id ?? '');
  const book = books.find((b) => b.id === topic.bookId);
  const palace = palaces.find((p) => p.id === palaceId);
  const counts = countCards(cards, now);
  const fresh = Math.min(counts.fresh, newAllowance(allCards, now));
  const placed = cards.filter((c) => c.palaceId && c.locusId).length;
  const sorted = useMemo(() => [...cards].sort((a, b) => a.createdAt - b.createdAt), [cards]);
  const about = scope.trim() ? `«${topic.title}» (${scope.trim()})` : `«${topic.title}»`;

  /** Opens the book with the memory coach already asked to do something. */
  const askCoach = (text: string) => {
    if (!book) return;
    setJump({ bookId: book.id, ask: { agentId: COACH, text } });
    onOpenBook(book.id);
  };
  const remove = () => {
    if (!confirm(`Видалити тему «${topic.title}» разом з її картками (${cards.length})?`)) return;
    void deleteTopic(topic.id);
    go('#/study');
  };

  return (
    <div className="library study">
      <header className="library-bar">
        <button className="icon-btn" onClick={() => go('#/study')} title="До навчання" aria-label="До навчання">
          <ArrowLeft size={20} />
        </button>
        <input
          className="study-title"
          value={title}
          aria-label="Назва теми"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== topic.title && void updateTopic(topic.id, { title: title.trim() })}
        />
        <button className="icon-btn" onClick={remove} title="Видалити тему" aria-label="Видалити тему">
          <Trash2 size={18} />
        </button>
      </header>

      <main className="library-main study-main">
        <section className="study-section">
          <div className="field-pair">
            <label className="field column">
              <span>Книга</span>
              <select value={topic.bookId ?? ''} onChange={(e) => void updateTopic(topic.id, { bookId: e.target.value || undefined })}>
                <option value="">— без книги —</option>
                {books.map((b) => (
                  <option key={b.id} value={b.id}>
                    {truncate(b.title, 60)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field column">
              <span>Яка частина</span>
              <input value={scope} onChange={(e) => setScope(e.target.value)} onBlur={() => scope !== (topic.scope ?? '') && void updateTopic(topic.id, { scope: scope.trim() || undefined })} placeholder="розділ 3, стор. 40–62…" />
            </label>
          </div>
        </section>

        <ol className="study-steps">
          <li>
            <h3>Питання до читання</h3>
            <p className="muted">Спробуйте відповісти ще до читання. Навіть невдала спроба допомагає потім запам’ятати.</p>
            <button
              className="btn small"
              disabled={!book}
              onClick={() =>
                askCoach(`Я збираюся вивчити тему ${about}. Постав мені 4–5 запитань до читання за цією частиною книги — по одному, без відповідей, поки я не спробую відповісти сам.`)
              }
            >
              <Sparkles size={14} /> Отримати питання
            </button>
          </li>
          <li>
            <h3>Прочитати</h3>
            <p className="muted">Читайте, шукаючи відповіді на ці питання. Виділяйте мало: важливе стане картками.</p>
            <button className="btn small" disabled={!book} onClick={() => book && onOpenBook(book.id)}>
              <BookOpen size={14} /> Відкрити книгу
            </button>
          </li>
          <li>
            <h3>Пригадати без книги</h3>
            <p className="muted">Закрийте книгу й запишіть усе, що пам’ятаєте. Прогалини покажуть, що варто повторити.</p>
            <textarea
              rows={4}
              value={recall}
              onChange={(e) => setRecall(e.target.value)}
              onBlur={() => recall !== (topic.recall ?? '') && void updateTopic(topic.id, { recall: recall.trim() || undefined })}
              placeholder="Своїми словами, не підглядаючи…"
            />
            <MicButton
              onText={(spoken) =>
                setRecall((current) => {
                  const next = appendSpoken(current, spoken);
                  void updateTopic(topic.id, { recall: next });
                  return next;
                })
              }
            />
            <button
              className="btn small"
              disabled={!book || recall.trim().length < 20}
              onClick={() =>
                askCoach(
                  `Я вивчаю тему ${about} і записав з пам’яті, що запам’ятав:\n\n"""\n${recall.trim()}\n"""\n\nПорівняй це з текстом книги: що правильно, що пропущено, де помилки. Потім зроби картки для прогалин.`,
                )
              }
            >
              <Sparkles size={14} /> Перевірити з AI
            </button>
          </li>
          <li>
            <h3>
              Картки <span className="pill">{cards.length}</span>
            </h3>
            <p className="muted">Одна думка — одна картка. Запитання має змушувати згадати, а не впізнати.</p>
            <div className="study-actions">
              <button className="btn small" onClick={() => setEditing('new')}>
                <Plus size={14} /> Додати картку
              </button>
              <button
                className="btn small"
                disabled={!book}
                onClick={() => askCoach(`Зроби картки для запам’ятовування з теми ${about}: 8–12 ключових фактів та ідей із цієї частини книги. Спершу перевір, які картки вже є.`)}
              >
                <Sparkles size={14} /> Згенерувати з книги
              </button>
            </div>
          </li>
          <li>
            <h3>
              Палац пам’яті{' '}
              <span className="pill">
                {placed} з {cards.length}
              </span>
            </h3>
            <p className="muted">Залиште кожну думку на зупинці знайомого маршруту у вигляді яскравого образу — і зможете згадати все по порядку.</p>
            {palaces.length ? (
              <div className="study-actions">
                <select value={palaceId} onChange={(e) => setPalaceId(e.target.value)} aria-label="Палац">
                  {palaces.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button className="btn small" disabled={!palace?.loci.length || placed === cards.length} onClick={() => palace && void placeInOrder(palace, sorted)}>
                  <MapPin size={14} /> Розкласти по порядку
                </button>
                <button
                  className="btn small"
                  disabled={!book || !placed}
                  onClick={() =>
                    askCoach(
                      `Допоможи з палацом пам’яті для теми ${about}. Подивись мої картки та палац «${palace?.name ?? ''}» і для кожної розкладеної картки, у якої ще немає образу, придумай яскравий образ, що пов’язує її зміст із місцем, і збережи його.`,
                    )
                  }
                >
                  <Sparkles size={14} /> Образи від AI
                </button>
                <button className="btn small" disabled={!palace || !allCards.some((c) => c.palaceId === palace.id)} onClick={() => palace && go(`#/review/palace/${palace.id}`)}>
                  <Footprints size={14} /> Прогулянка
                </button>
              </div>
            ) : (
              <button className="btn small" onClick={() => go('#/study')}>
                <Landmark size={14} /> Спершу створіть палац
              </button>
            )}
          </li>
          <li>
            <h3>Повторення за розкладом</h3>
            <p className="muted">
              {counts.due} до повторення, {fresh} нових на сьогодні. Розклад підлаштовується під те, як ви відповідаєте.
            </p>
            <button className="btn small primary" disabled={!counts.due && !fresh} onClick={() => go(`#/review/topic/${topic.id}`)}>
              <Play size={14} /> Повторити зараз
            </button>
          </li>
        </ol>

        <section className="study-section">
          <div className="study-head">
            <h2>Картки</h2>
          </div>
          {!sorted.length && <p className="panel-empty">Тут з’являться картки цієї теми.</p>}
          <ul className="study-cards">
            {sorted.map((card) => {
              const home = palaces.find((p) => p.id === card.palaceId);
              const locus = home?.loci.find((l) => l.id === card.locusId);
              return (
                <li key={card.id}>
                  <button className="study-card" onClick={() => setEditing(card)}>
                    <strong>{card.front}</strong>
                    <span className="muted">{truncate(card.back, 160)}</span>
                    <span className="study-card-meta">
                      <span className={cx('pill', isDue(card, now) && 'due', card.state === 'new' && 'fresh')}>{dueLabel(card, now)}</span>
                      {locus && (
                        <span className="pill">
                          <MapPin size={11} /> {locus.name}
                        </span>
                      )}
                      {(card.image || card.sketch?.strokes.length) && (
                        <span className="pill">
                          <Sparkles size={11} /> образ
                        </span>
                      )}
                      {card.label && <span className="muted">{card.label}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </main>

      {editing && <CardEditor card={editing === 'new' ? undefined : editing} target={{ topicId: topic.id }} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---------- One memory palace ----------

function PalaceView({ palace, cards }: { palace: MemoryPalace; cards: StudyCard[] }) {
  const [name, setName] = useState(palace.name);
  const [added, setAdded] = useState('');
  const save = (loci: MemoryPalace['loci'], nextName = name) => void savePalace({ ...palace, name: nextName.trim() || palace.name, loci });
  const move = (index: number, by: number) => {
    const loci = [...palace.loci];
    const [item] = loci.splice(index, 1);
    loci.splice(index + by, 0, item);
    save(loci);
  };
  const add = () => {
    if (!added.trim()) return;
    save([...palace.loci, { id: uid(), name: added.trim() }]);
    setAdded('');
  };
  const remove = () => {
    if (!confirm(`Видалити палац «${palace.name}»? Картки залишаться, але вже не будуть розкладені.`)) return;
    void deletePalace(palace.id);
    go('#/study');
  };

  return (
    <div className="library study">
      <header className="library-bar">
        <button className="icon-btn" onClick={() => go('#/study')} title="До навчання" aria-label="До навчання">
          <ArrowLeft size={20} />
        </button>
        <input className="study-title" value={name} aria-label="Назва палацу" onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== palace.name && save(palace.loci)} />
        <button className="icon-btn" onClick={remove} title="Видалити палац" aria-label="Видалити палац">
          <Trash2 size={18} />
        </button>
      </header>

      <main className="library-main study-main">
        <section className="study-section">
          <p className="muted">
            Оберіть місце, яке знаєте до дрібниць, і пройдіть ним подумки в одному й тому самому порядку. Кожна зупинка має бути окремою й помітною: двері, вішак, диван. На зупинках ви
            залишатимете образи.
          </p>
          {!palace.loci.length && (
            <div className="study-actions">
              {PALACE_TEMPLATES.map((template) => (
                <button
                  key={template.name}
                  className="chip"
                  onClick={() => {
                    setName(template.name);
                    save(
                      template.loci.map((n) => ({ id: uid(), name: n })),
                      template.name,
                    );
                  }}
                >
                  {template.name}
                </button>
              ))}
              <span className="muted small">— заготовки; назви зупинок замініть на свої.</span>
            </div>
          )}
          <ol className="palace-loci">
            {palace.loci.map((locus, i) => {
              const here = cards.filter((c) => c.locusId === locus.id);
              return (
                <li key={locus.id}>
                  <span className="palace-number">{i + 1}</span>
                  <div className="palace-locus">
                    <input
                      defaultValue={locus.name}
                      aria-label={`Зупинка ${i + 1}`}
                      onBlur={(e) => {
                        const value = e.target.value.trim();
                        if (value && value !== locus.name) save(palace.loci.map((l) => (l.id === locus.id ? { ...l, name: value } : l)));
                      }}
                    />
                    {here.map((card) => (
                      <small key={card.id} className="muted">
                        <Pencil size={11} /> {truncate(card.front, 70)}
                        {card.image ? ` — ${truncate(card.image, 90)}` : ''}
                        {card.sketch?.strokes.length ? ' · є малюнок' : ''}
                      </small>
                    ))}
                  </div>
                  <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Вище" aria-label="Вище">
                    <ChevronUp size={16} />
                  </button>
                  <button className="icon-btn" disabled={i === palace.loci.length - 1} onClick={() => move(i, 1)} title="Нижче" aria-label="Нижче">
                    <ChevronDown size={16} />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => (!here.length || confirm('Прибрати зупинку? Розкладені на ній картки залишаться без місця.')) && save(palace.loci.filter((l) => l.id !== locus.id))}
                    title="Прибрати зупинку"
                    aria-label="Прибрати зупинку"
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              );
            })}
          </ol>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input value={added} onChange={(e) => setAdded(e.target.value)} placeholder="Наступна зупинка маршруту" aria-label="Нова зупинка" />
            <button className="btn" disabled={!added.trim()}>
              <Plus size={15} /> Додати
            </button>
          </form>
        </section>

        <section className="study-section">
          <p className="muted">
            Розкладено карток: {cards.length}. Розкласти картки теми можна на її сторінці; образи можна написати самому в картці або попросити «Тренера пам’яті» у книзі.
          </p>
          <button className="btn primary" disabled={!cards.length} onClick={() => go(`#/review/palace/${palace.id}`)}>
            <Footprints size={16} /> Пройти маршрут
          </button>
        </section>
      </main>
    </div>
  );
}

const days = (n: number) => `${String(Math.round(n * 10) / 10).replace('.', ',')} д`;

/** What fitting the schedule to the reader has changed so far, in a sentence. */
function fitSummary(fit: ScheduleFit | null, personal: boolean): string {
  if (!personal) return 'Вимкнено: для нових карток діють типові інтервали алгоритму FSRS.';
  const names = ['«Знову»', '«Важко»', '«Добре»', '«Легко»'];
  const moved = fit ? [0, 1, 2, 3].filter((i) => fit.samples[i] >= MIN_SAMPLES && Math.abs(fit.stability[i] - DEFAULT_INITIAL_STABILITY[i]) / DEFAULT_INITIAL_STABILITY[i] > 0.05) : [];
  if (fit && moved.length) {
    return `Підлаштовано за вашими відповідями: після першої відповіді ${moved.map((i) => `${names[i]} картка тримається ${days(fit.stability[i])} (типово ${days(DEFAULT_INITIAL_STABILITY[i])})`).join(', ')}.`;
  }
  const most = fit ? Math.max(...fit.samples) : 0;
  return most >= MIN_SAMPLES
    ? 'Ваші відповіді поки що збігаються з типовими інтервалами — розклад лишається як є.'
    : `Перші інтервали нових карток підлаштуються під вас, щойно набереться досить повторень: потрібно ${MIN_SAMPLES} карток з однаковою першою відповіддю, які ви побачили знову в інший день (зараз найбільше — ${most}).`;
}
