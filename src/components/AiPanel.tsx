import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, History, KeyRound, LoaderCircle, MessageSquarePlus, Send, Settings, Square, Trash2, TriangleAlert, X } from 'lucide-react';
import { agentsFor, buildSystemPrompt, getAgent } from '../ai/agents';
import { LIBRARY_CHAT } from '../lib/chats';
import { resolveProvider } from '../ai/providers';
import { describeError, plainHistory, runAgentTurn } from '../ai/run';
import type { AgentContext } from '../ai/tools';
import { db, deleteChat } from '../db';
import { setJump } from '../lib/jump';
import { renderMarkdown } from '../lib/markdown';
import { cx, truncate, uid } from '../lib/utils';
import { getSettings, updateSettings, useSettings } from '../settings';
import type { ChatThread, UiMessage, UiPart } from '../types';
import { ChatHistory } from './ChatHistory';
import { appendSpoken, MicButton } from './MicButton';

/** A message the reader triggered from outside the panel (e.g. "Explain" on a selection). */
export interface AiRequest {
  id: string;
  agentId: string;
  text: string;
  quote?: string;
}

interface Props {
  ctx: AgentContext;
  request: AiRequest | null;
  onRequestHandled(): void;
  /** Selected text waiting to be attached to the next question. */
  quote: string | null;
  onQuoteClear(): void;
  /** A saved conversation to show (asked for from the history of another book or from the library). */
  openThread?: string | null;
  onOpenSettings(): void;
  onClose(): void;
}

type AssistantMessage = Extract<UiMessage, { role: 'assistant' }>;

export function AiPanel({ ctx, request, onRequestHandled, quote, onQuoteClear, openThread, onOpenSettings, onClose }: Props) {
  const settings = useSettings();
  const bookId = ctx.book.id;
  // Which conversation to show: the latest one with an agent, a new one, or a particular saved one.
  const agents = useMemo(() => agentsFor(Boolean(ctx.noBook)), [ctx.noBook]);
  const [wanted, setWanted] = useState<{ agentId: string; thread: 'latest' | 'new' | string }>(() => ({ agentId: agentsFor(Boolean(ctx.noBook))[0].id, thread: 'latest' }));
  const agentId = wanted.agentId;
  const setAgentId = useCallback((id: string) => setWanted({ agentId: id, thread: 'latest' }), []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [interim, setInterim] = useState('');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [ui, setUi] = useState<UiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [input, setInput] = useState('');
  // Wire-format history of the loaded thread and which API family it belongs to.
  const apiRef = useRef<{ format: 'anthropic' | 'openai' | null; messages: unknown[] }>({ format: null, messages: [] });
  const abortRef = useRef<AbortController | null>(null);
  // The conversation currently loaded into `ui`/`apiRef` (null while loading); nothing is sent until it is there.
  const [loaded, setLoaded] = useState<{ id: string; agentId: string; title?: string; createdAt: number } | null>(null);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const agent = getAgent(agentId);
  const resolved = resolveProvider(settings);
  const provider = 'provider' in resolved ? resolved.provider : null;

  // Conversations are kept: opening an agent continues its latest one about this book.
  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setUi([]);
    apiRef.current = { format: null, messages: [] };
    (async () => {
      let thread: ChatThread | undefined;
      if (wanted.thread === 'latest') {
        const own = await db.chats.where('bookId').equals(bookId).toArray();
        thread = own.filter((t) => t.agentId === wanted.agentId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      } else if (wanted.thread !== 'new') {
        thread = await db.chats.get(wanted.thread);
      }
      if (!alive) return;
      // A turn interrupted by closing the app is shown as stopped.
      setUi((thread?.ui ?? []).map((m) => (m.role === 'assistant' && m.status === 'streaming' ? { ...m, status: 'stopped' } : m)));
      apiRef.current = { format: thread?.format ?? (thread?.api.length ? 'anthropic' : null), messages: thread?.api ?? [] };
      setLoaded({ id: thread?.id ?? uid(), agentId: wanted.agentId, title: thread?.title, createdAt: thread?.createdAt ?? thread?.updatedAt ?? Date.now() });
    })();
    return () => {
      alive = false;
    };
  }, [bookId, wanted]);

  // A saved conversation asked for from outside: the history of another book, or the library's search.
  useEffect(() => {
    if (!openThread) return;
    let alive = true;
    void db.chats.get(openThread).then((thread) => {
      if (alive && thread?.bookId === bookId) setWanted({ agentId: thread.agentId, thread: thread.id });
    });
    return () => {
      alive = false;
    };
  }, [openThread, bookId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [ui, thinking]);

  const send = useCallback(
    async (text: string, attached?: string) => {
      const current = getSettings();
      const target = resolveProvider(current);
      if (!('provider' in target) || !text.trim() || abortRef.current || !loaded) return;
      const thread = loaded;
      const targetAgentId = thread.agentId;
      const active = target.provider;

      const userMsg: UiMessage = { id: uid(), role: 'user', text: text.trim(), quote: attached };
      let assistant: AssistantMessage = { id: uid(), role: 'assistant', parts: [], status: 'streaming' };
      const before = uiRef.current;
      setUi([...before, userMsg, assistant]);
      stickRef.current = true;

      // A history recorded for the other API family cannot be replayed as is; fall back to its plain text.
      const history = apiRef.current.format === active.kind || !apiRef.current.messages.length ? apiRef.current.messages : plainHistory(before);

      // Streamed text is applied once per frame instead of once per token.
      let frame = 0;
      const flush = () => {
        frame = 0;
        const snapshot = assistant;
        setUi((prev) => prev.map((m) => (m.id === snapshot.id ? snapshot : m)));
      };
      const update = (fn: (m: AssistantMessage) => AssistantMessage, immediate = false) => {
        assistant = fn(assistant);
        if (immediate) {
          cancelAnimationFrame(frame);
          flush();
        } else {
          frame ||= requestAnimationFrame(flush);
        }
      };
      const mapTool = (parts: UiPart[], id: string, status: 'ok' | 'err'): UiPart[] =>
        parts.map((p) => (p.type === 'tool' && p.call.id === id ? { type: 'tool', call: { ...p.call, status } } : p));

      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      let stepStart = 0;

      try {
        const result = await runAgentTurn({
          provider: active,
          system: (tools) => buildSystemPrompt(getAgent(targetAgentId), ctxRef.current.book, current.aiLanguage, tools, ctxRef.current.noBook),
          history,
          userText: text.trim(),
          quote: attached,
          ctx: ctxRef.current,
          signal: controller.signal,
          callbacks: {
            onStepStart: () => (stepStart = assistant.parts.length),
            onStepDiscard: () => update((m) => ({ ...m, parts: m.parts.slice(0, stepStart) }), true),
            onThinking: setThinking,
            onText: (delta) =>
              update((m) => {
                const last = m.parts[m.parts.length - 1];
                if (last?.type === 'text') return { ...m, parts: [...m.parts.slice(0, -1), { type: 'text', text: last.text + delta }] };
                return { ...m, parts: [...m.parts, { type: 'text', text: delta }] };
              }),
            onToolStart: (id, label) => update((m) => ({ ...m, parts: [...m.parts, { type: 'tool', call: { id, label, status: 'run' } }] }), true),
            onToolEnd: (id, ok) => update((m) => ({ ...m, parts: mapTool(m.parts, id, ok ? 'ok' : 'err') }), true),
          },
        });
        apiRef.current = { format: active.kind, messages: result.messages };
        // Remember that this model cannot use tools, so the next turn does not have to find out again.
        if (result.toolsUnsupported && active.kind === 'openai') {
          if (active.id !== 'browser') updateSettings(active.id === 'local' ? { localTools: false } : { openrouterTools: false });
        }
        update(
          (m) => ({
            ...m,
            status: result.status === 'refused' ? 'refused' : 'done',
            note:
              result.status === 'refused'
                ? `Модель відмовилася відповідати на цей запит.${result.note ? ` ${result.note}` : ''}`
                : result.status === 'truncated'
                  ? 'Відповідь обрізано через обмеження довжини.'
                  : result.note,
          }),
          true,
        );
      } catch (err) {
        // The interrupted turn is not added to the API history, so the next question starts clean.
        const stopped = controller.signal.aborted;
        if (history !== apiRef.current.messages) apiRef.current = { format: active.kind, messages: history };
        update(
          (m) => ({
            ...m,
            parts: m.parts.map((p) => (p.type === 'tool' && p.call.status === 'run' ? { type: 'tool', call: { ...p.call, status: 'err' } } : p)),
            status: stopped ? 'stopped' : 'error',
            note: stopped ? undefined : describeError(err, active),
          }),
          true,
        );
      } finally {
        cancelAnimationFrame(frame);
        abortRef.current = null;
        setBusy(false);
        setThinking(false);
        await db.chats.put({
          id: thread.id,
          bookId,
          agentId: targetAgentId,
          title: thread.title ?? truncate(text.trim().replace(/\s+/g, ' '), 70),
          createdAt: thread.createdAt,
          ui: [...before, userMsg, assistant],
          api: apiRef.current.messages,
          format: apiRef.current.format ?? undefined,
          updatedAt: Date.now(),
        });
      }
    },
    [bookId, loaded],
  );

  // Requests from the reader view: switch to the right agent, wait for its thread, then send.
  useEffect(() => {
    if (!request || busy) return;
    if (request.agentId !== agentId) {
      setAgentId(request.agentId);
      return;
    }
    if (!loaded || loaded.agentId !== agentId) return;
    setHistoryOpen(false);
    onRequestHandled();
    if (!('provider' in resolveProvider(getSettings()))) {
      setInput(request.text);
      return;
    }
    void send(request.text, request.quote);
  }, [request, agentId, loaded, busy, send, onRequestHandled, setAgentId]);

  const ready = loaded !== null && loaded.agentId === agentId;

  const submit = () => {
    if (busy || !ready || !provider || !input.trim()) return;
    const text = input;
    setInput('');
    onQuoteClear();
    void send(text, quote ?? undefined);
  };

  const deleteThread = async () => {
    if (busy || !loaded || !confirm('Видалити цю розмову?')) return;
    await deleteChat(loaded.id);
    setWanted({ agentId, thread: 'new' });
  };

  const openSaved = (thread: ChatThread) => {
    if (busy) return;
    setHistoryOpen(false);
    if (thread.bookId === bookId) return setWanted({ agentId: thread.agentId, thread: thread.id });
    // A conversation about another book opens in that book.
    setJump({ bookId: thread.bookId, thread: thread.id });
    // A conversation held in the library opens there.
    location.hash = thread.bookId === LIBRARY_CHAT ? '' : `#/book/${encodeURIComponent(thread.bookId)}`;
  };

  return (
    <aside className="ai-panel">
      <header className="ai-header">
        <div className="ai-title">
          <agent.icon size={18} />
          <div>
            <strong>{agent.name}</strong>
            <small className="muted" title={provider?.name}>
              {provider?.name ?? 'AI не налаштовано'}
            </small>
          </div>
        </div>
        <button className={cx('icon-btn', historyOpen && 'active')} onClick={() => setHistoryOpen((o) => !o)} title="Історія розмов і пошук у них" aria-label="Історія розмов">
          <History size={16} />
        </button>
        <button
          className="icon-btn"
          onClick={() => {
            setHistoryOpen(false);
            setWanted({ agentId, thread: 'new' });
          }}
          disabled={busy || (!ui.length && !historyOpen)}
          title="Нова розмова (ця збережеться в історії)"
          aria-label="Нова розмова"
        >
          <MessageSquarePlus size={16} />
        </button>
        <button className="icon-btn" onClick={() => void deleteThread()} disabled={busy || !ui.length || historyOpen} title="Видалити цю розмову" aria-label="Видалити цю розмову">
          <Trash2 size={16} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Налаштування AI: провайдер, модель, ключ">
          <Settings size={16} />
        </button>
        <button className="icon-btn" onClick={onClose} title="Закрити">
          <X size={18} />
        </button>
      </header>

      <div className="agent-chips" role="tablist" aria-label="Агенти">
        {agents.map((a) => (
          <button
            key={a.id}
            role="tab"
            aria-selected={a.id === agentId}
            className={cx('chip', a.id === agentId && 'active')}
            onClick={() => !busy && setAgentId(a.id)}
            disabled={busy && a.id !== agentId}
            title={a.description}
          >
            <a.icon size={14} />
            {a.name}
          </button>
        ))}
      </div>

      {historyOpen && (
        <div className="ai-messages">
          <ChatHistory bookId={bookId} currentThreadId={loaded?.id} onOpen={openSaved} />
        </div>
      )}

      <div
        className="ai-messages"
        hidden={historyOpen}
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {!provider && (
          <div className="ai-setup">
            <KeyRound size={22} />
            <p>{'missing' in resolved ? resolved.missing : ''}</p>
            <p className="small">Можна працювати з Claude, з моделями OpenRouter (є безкоштовні) або з локальними моделями через Ollama чи LM Studio.</p>
            <button className="btn primary" onClick={onOpenSettings}>
              Налаштувати AI
            </button>
          </div>
        )}

        {provider && ready && !ui.length && (
          <div className="ai-empty">
            <p className="muted">
              {agent.description}.{' '}
              {provider.kind === 'openai' && !provider.tools ? 'Ця модель бачить лише текст поточної сторінки.' : 'Агент сам читає потрібні сторінки книги.'}
            </p>
            {agent.starters.map((s) => (
              <button
                key={s}
                className="starter"
                disabled={busy}
                onClick={() => {
                  onQuoteClear();
                  void send(s, quote ?? undefined);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {ui.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="msg user">
              {m.quote && <blockquote>{truncate(m.quote, 280)}</blockquote>}
              <p>{m.text}</p>
            </div>
          ) : (
            <AssistantBubble key={m.id} message={m} thinking={thinking && m.status === 'streaming'} />
          ),
        )}
      </div>

      <footer className="ai-input" hidden={historyOpen}>
        {voiceError && <div className="msg-note error">{voiceError}</div>}
        {quote && (
          <div className="quote-chip">
            <span>«{truncate(quote, 90)}»</span>
            <button className="icon-btn" onClick={onQuoteClear} title="Не додавати фрагмент">
              <X size={14} />
            </button>
          </div>
        )}
        <div className="ai-input-row">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={interim ? `${interim}…` : provider ? `Запитайте агента «${agent.name}»…` : 'Спершу налаштуйте AI'}
            disabled={!provider}
            rows={2}
          />
          <MicButton
            disabled={!provider}
            onText={(spoken) => {
              setVoiceError(null);
              setInput((current) => appendSpoken(current, spoken));
            }}
            onInterim={setInterim}
            onError={setVoiceError}
          />
          {busy ? (
            <button className="btn primary icon-only" onClick={() => abortRef.current?.abort()} title="Зупинити">
              <Square size={16} />
            </button>
          ) : (
            <button className="btn primary icon-only" onClick={submit} disabled={!provider || !ready || !input.trim()} title="Надіслати (Enter)">
              <Send size={16} />
            </button>
          )}
        </div>
      </footer>
    </aside>
  );
}

/**
 * An answer as formatted text. Diagrams the model wrote as Mermaid code are drawn in place once
 * the answer is complete; while it is still arriving they show as the code they are.
 */
const Markdown = memo(function Markdown({ text, final }: { text: string; final: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  const theme = useSettings().theme;

  useEffect(() => {
    const blocks = final ? Array.from(ref.current?.querySelectorAll<HTMLElement>('pre > code.language-mermaid') ?? []) : [];
    if (!blocks.length) return;
    let alive = true;
    void import('../lib/diagram').then(async ({ renderDiagram }) => {
      for (const code of blocks) {
        const pre = code.parentElement;
        try {
          const svg = await renderDiagram(code.textContent ?? '', theme === 'dark');
          if (!alive || !pre?.isConnected) return;
          const figure = document.createElement('div');
          figure.className = 'diagram';
          figure.innerHTML = svg;
          pre.replaceWith(figure);
        } catch {
          // Not a valid diagram: the code stays as it is, which is still readable.
          pre?.classList.add('diagram-failed');
        }
      }
    });
    return () => {
      alive = false;
    };
    // `html` stands for the text: a changed answer is rendered anew, and its diagrams with it.
  }, [html, final, theme]);

  return <div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

function AssistantBubble({ message, thinking }: { message: AssistantMessage; thinking: boolean }) {
  const waiting = message.status === 'streaming' && (thinking || !message.parts.length);
  return (
    <div className={cx('msg assistant', message.status)}>
      {message.parts.map((part, i) =>
        part.type === 'text' ? (
          <Markdown key={i} text={part.text} final={message.status !== 'streaming'} />
        ) : (
          <div key={part.call.id} className={cx('tool-call', part.call.status)}>
            {part.call.status === 'run' ? <LoaderCircle size={13} className="spin" /> : part.call.status === 'ok' ? <Check size={13} /> : <TriangleAlert size={13} />}
            <span>{part.call.label}</span>
          </div>
        ),
      )}
      {waiting && (
        <div className="tool-call run">
          <LoaderCircle size={13} className="spin" />
          <span>Думаю…</span>
        </div>
      )}
      {message.status === 'stopped' && <div className="msg-note">Зупинено</div>}
      {message.note && (
        <div className={cx('msg-note', (message.status === 'error' || message.status === 'refused') && 'error')}>{message.note}</div>
      )}
    </div>
  );
}
