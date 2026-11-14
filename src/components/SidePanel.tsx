import { useState } from 'react';
import { Bookmark, ChevronDown, ChevronRight, Download, Highlighter, List, Pencil, Search, Sparkles, StickyNote, Trash2, X } from 'lucide-react';
import { sortAnnotations } from '../lib/notes';
import { cx, pluralUk, truncate } from '../lib/utils';
import { HIGHLIGHT_COLORS } from '../settings';
import type { Annotation, TocItem } from '../types';
import { SketchPreview } from './NoteEditor';
import { SearchTab, type SearchTabProps } from './SearchTab';

export type { SearchState, SemanticState } from './SearchTab';

export type SideTab = 'toc' | 'search' | 'notes' | 'bookmarks';

interface Props extends SearchTabProps {
  tab: SideTab;
  onTab(tab: SideTab): void;
  onClose(): void;
  toc: TocItem[];
  currentUnit: number;
  onTocPick(item: TocItem): void;
  annotations: Annotation[];
  onAnnotationPick(a: Annotation): void;
  onAnnotationEdit(a: Annotation): void;
  onAnnotationDelete(a: Annotation): void;
  onExportNotes(): void;
}

const TABS: { id: SideTab; label: string; icon: typeof List }[] = [
  { id: 'toc', label: 'Зміст', icon: List },
  { id: 'search', label: 'Пошук', icon: Search },
  { id: 'notes', label: 'Нотатки', icon: StickyNote },
  { id: 'bookmarks', label: 'Закладки', icon: Bookmark },
];

export function SidePanel(props: Props) {
  const { tab } = props;
  return (
    <aside className="side-panel">
      <div className="panel-tabs">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} className={cx('panel-tab', tab === id && 'active')} onClick={() => props.onTab(id)} title={label}>
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
        <button className="icon-btn panel-close" onClick={props.onClose} title="Закрити панель">
          <X size={18} />
        </button>
      </div>
      <div className="panel-body">
        {tab === 'toc' && <TocTab {...props} />}
        {tab === 'search' && <SearchTab {...props} />}
        {tab === 'notes' && <NotesTab {...props} />}
        {tab === 'bookmarks' && <BookmarksTab {...props} />}
      </div>
    </aside>
  );
}

/** The deepest TOC entry that starts at or before the current position, preceded by its ancestors. */
function findCurrentPath(items: TocItem[], unit: number): TocItem[] {
  let best: TocItem[] = [];
  const walk = (list: TocItem[], parents: TocItem[]) => {
    for (const item of list) {
      const path = [...parents, item];
      const bestUnit = best[best.length - 1]?.unit ?? -1;
      if (item.unit !== undefined && item.unit <= unit && item.unit >= bestUnit) best = path;
      walk(item.children, path);
    }
  };
  walk(items, []);
  return best;
}

function TocTab({ toc, currentUnit, onTocPick }: Props) {
  if (!toc.length) return <p className="panel-empty">У цій книзі немає змісту.</p>;
  const path = findCurrentPath(toc, currentUnit);
  return (
    <ul className="toc">
      {toc.map((item, i) => (
        <TocNode key={i} item={item} depth={0} path={path} onPick={onTocPick} />
      ))}
    </ul>
  );
}

function TocNode({ item, depth, path, onPick }: { item: TocItem; depth: number; path: TocItem[]; onPick(item: TocItem): void }) {
  const onPath = path.includes(item);
  const [open, setOpen] = useState(depth < 1 || onPath);
  const hasChildren = item.children.length > 0;
  // A collapsed branch stands in for the current entry hidden inside it.
  const isCurrent = item === path[path.length - 1] || (onPath && !open);
  return (
    <li>
      <div className={cx('toc-row', isCurrent && 'current')} style={{ paddingLeft: 8 + depth * 14 }}>
        {hasChildren ? (
          <button className="toc-toggle" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Згорнути' : 'Розгорнути'}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="toc-toggle" />
        )}
        <button className="toc-title" onClick={() => onPick(item)} disabled={item.unit === undefined && !item.href}>
          {item.title}
        </button>
      </div>
      {hasChildren && open && (
        <ul>
          {item.children.map((child, i) => (
            <TocNode key={i} item={child} depth={depth + 1} path={path} onPick={onPick} />
          ))}
        </ul>
      )}
    </li>
  );
}

function NotesTab({ annotations, onAnnotationPick, onAnnotationEdit, onAnnotationDelete, onExportNotes }: Props) {
  const items = sortAnnotations(annotations.filter((a) => a.type !== 'bookmark'));
  if (!items.length) {
    return (
      <p className="panel-empty">
        Ще немає нотаток. Виділіть текст, щоб підсвітити його чи додати нотатку, або попросіть AI-агента «Конспект» зробити нотатки за вас.
      </p>
    );
  }
  return (
    <>
      <div className="panel-actions">
        <span className="panel-meta">
          {items.length} {pluralUk(items.length, 'запис', 'записи', 'записів')}
        </span>
        <button className="btn ghost small" onClick={onExportNotes} title="Зберегти всі нотатки у файл Markdown">
          <Download size={14} /> Експорт
        </button>
      </div>
      <ul className="notes">
        {items.map((a) => (
          <li key={a.id} className="note-card" style={{ borderLeftColor: HIGHLIGHT_COLORS[a.color] }}>
            <button className="note-main" onClick={() => onAnnotationPick(a)}>
              <span className="note-head">
                {a.type === 'note' ? <StickyNote size={14} /> : <Highlighter size={14} />}
                <span>{a.label}</span>
                {a.author === 'agent' && (
                  <span className="badge" title="Створено AI-агентом">
                    <Sparkles size={11} /> AI
                  </span>
                )}
              </span>
              {a.quote && <span className="note-quote-line">«{truncate(a.quote, 220)}»</span>}
              {a.text && <span className="note-body">{a.text}</span>}
              {a.sketch?.strokes.length ? <SketchPreview strokes={a.sketch.strokes} aspect={a.sketch.aspect} /> : null}
            </button>
            <div className="note-tools">
              <button className="icon-btn" onClick={() => onAnnotationEdit(a)} title="Редагувати">
                <Pencil size={14} />
              </button>
              <button className="icon-btn" onClick={() => onAnnotationDelete(a)} title="Видалити">
                <Trash2 size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function BookmarksTab({ annotations, onAnnotationPick, onAnnotationDelete }: Props) {
  const items = sortAnnotations(annotations.filter((a) => a.type === 'bookmark'));
  if (!items.length) return <p className="panel-empty">Закладок ще немає. Натисніть на значок закладки вгорі, щоб позначити поточне місце.</p>;
  return (
    <ul className="notes">
      {items.map((a) => (
        <li key={a.id} className="note-card bookmark-card">
          <button className="note-main" onClick={() => onAnnotationPick(a)}>
            <span className="note-head">
              <Bookmark size={14} />
              <span>{a.label}</span>
            </span>
            {a.quote && <span className="note-quote-line">{truncate(a.quote, 140)}</span>}
          </button>
          <div className="note-tools">
            <button className="icon-btn" onClick={() => onAnnotationDelete(a)} title="Видалити закладку">
              <Trash2 size={14} />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
