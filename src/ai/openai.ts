// Chat loop for OpenAI-compatible servers: OpenRouter and local runtimes (Ollama, LM Studio, llama.cpp).
import { browserChat } from './browser-llm';
import { authHeaders, isBlockedMixedContent, isOpenRouter, MIXED_CONTENT_HINT, ProviderError, readErrorMessage, type ChatProvider } from './providers';
import { buildUserContent, getTools, runTool, type ToolCallResult, type ToolEnv } from './tools';
import { MAX_STEPS, type RunOptions, type RunResult } from './types';

type OpenAiProvider = Extract<ChatProvider, { kind: 'openai' }>;

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface StreamChunk {
  error?: { message?: string; code?: number | string };
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

/** Servers answer like this when the chosen model cannot call tools. */
const NO_TOOLS = /does not support tools|support tool use|tools? (is|are) not supported|function calling is not|tool calling is not/i;

/** Parses a `text/event-stream` body into JSON payloads. */
async function* readEvents(res: Response): AsyncGenerator<StreamChunk> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        // Comment lines (": keep-alive") and event names carry nothing we need.
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data) as StreamChunk;
        } catch {
          // A partial or non-JSON line: skip it rather than abort the whole answer.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Some local reasoning models write their chain of thought into the answer inside <think> tags.
 * Returns the part of the text that is meant for the reader.
 */
function visibleText(raw: string): string {
  const trimmed = raw.trimStart();
  if (trimmed.length < 7 && '<think>'.startsWith(trimmed)) return '';
  if (!trimmed.startsWith('<think>')) return raw;
  const end = trimmed.indexOf('</think>');
  return end < 0 ? '' : trimmed.slice(end + 8).trimStart();
}

/** A short reply that only announces work ("let me find…", "here is the search result:") instead of giving an answer. */
export function looksLikePromise(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 320) return false;
  return /:s*$/.test(t) || /(давайте|спочатку|для того,? щоб|щоб (дати|надати|знайти)|зараз (я )?(знайду|прочитаю|перегляну|подивлюся)|я (знайду|прочитаю|перегляну|подивлюся|створю|пошукаю)|потрібно (переглянути|знайти|прочитати)|let me|i will (look|search|read|check|find|create)|i'll (look|search|read|check|find|create)|first,? i)/i.test(t);
}

/**
 * A tool call written as text, when that is all the message is: Qwen-style `<tool_call>{"name", "arguments"}</tool_call>`,
 * a bare `{"name", "arguments"}` object, or `tool_name {arguments}`. Longer prose that merely mentions a tool is left alone.
 */
export function parseWrittenCall(text: string, names: string[]): { name: string; arguments: string } | null {
  const body = text.replace(/```(?:json)?/gi, '').trim();
  if (!body || body.length > 800) return null;
  const objectAt = (from: number): unknown => {
    const start = body.indexOf('{', from);
    if (start < 0) return undefined;
    // The longest balanced object from there, ignoring braces inside strings.
    let depth = 0;
    let quoted = false;
    for (let i = start; i < body.length; i++) {
      const c = body[i];
      if (quoted) {
        if (c === '\\') i++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  };
  const asCall = (value: unknown) => {
    if (!value || typeof value !== 'object') return null;
    const v = value as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof v.name !== 'string' || !names.includes(v.name)) return null;
    const args = v.arguments ?? v.parameters ?? {};
    return { name: v.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
  };
  const wrapped = asCall(objectAt(0));
  if (wrapped) return wrapped;
  for (const name of names) {
    const at = body.search(new RegExp(`(^|[^\\w])${name}\\s*\\(?\\s*\\{`));
    if (at < 0) continue;
    // Whatever stands before the name must be short: a stray word, not an explanation.
    if (at > 40) return null;
    const args = objectAt(at);
    if (args && typeof args === 'object') return { name, arguments: JSON.stringify(args) };
  }
  return null;
}

export async function runOpenAiTurn(opts: RunOptions, provider: OpenAiProvider): Promise<RunResult> {
  const { callbacks: cb, ctx, signal } = opts;
  const env: ToolEnv = { ctx, readLimit: provider.readLimit };
  let useTools = provider.tools;
  let toolsUnsupported = false;
  let nudged = false;
  const specs = getTools({ vision: provider.vision && ctx.engine.kind === 'fixed', noBook: ctx.noBook });
  const toolDefs = specs.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description(env), parameters: t.parameters },
  }));

  const history = opts.history as ChatMessage[];
  const userMessage = async (): Promise<ChatMessage> => ({
    role: 'user',
    // Without tools the model cannot open the book, so it gets the current page with the question.
    content: await buildUserContent(ctx, opts.userText, opts.quote, useTools ? null : { limit: provider.readLimit }),
  });
  let messages: ChatMessage[] = [...history, await userMessage()];

  for (let step = 0; step < MAX_STEPS; step++) {
    cb.onStepStart();
    let events: AsyncIterable<StreamChunk>;
    if (provider.id === 'browser') {
      // The model runs on this device; the first answer also has to load it, which the chat shows as a step.
      const loading = `load_${step}`;
      cb.onToolStart(loading, 'Готую модель у браузері');
      try {
        events = await browserChat(provider.model, [{ role: 'system', content: opts.system(false) }, ...messages], signal);
        cb.onToolEnd(loading, true);
      } catch (err) {
        cb.onToolEnd(loading, false);
        throw err;
      }
    } else {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      // The X-Title header is an OpenRouter extension; other services may refuse it in a CORS preflight.
      headers: authHeaders(provider.apiKey, isOpenRouter(provider.baseUrl) ? 'openrouter' : 'local'),
      signal,
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'system', content: opts.system(useTools) }, ...messages],
        stream: true,
        ...(useTools ? { tools: toolDefs } : {}),
      }),
    });

    if (!res.ok) {
      const message = await readErrorMessage(res);
      if (useTools && NO_TOOLS.test(message)) {
        // Carry on without tools: rebuild the turn with the page text included.
        useTools = false;
        toolsUnsupported = true;
        messages = [...history, await userMessage()];
        cb.onStepDiscard();
        continue;
      }
      throw new ProviderError(res.status, message, provider.id);
    }
    events = readEvents(res);
    }

    let raw = '';
    let shown = 0;
    let finish: string | null = null;
    const calls: { id: string; name: string; args: string }[] = [];
    try {
      for await (const chunk of events) {
        if (chunk.error) throw new ProviderError(Number(chunk.error.code) || 500, chunk.error.message ?? 'Помилка сервера моделі', provider.id);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.reasoning || delta?.reasoning_content) cb.onThinking(true);
        if (delta?.content) {
          raw += delta.content;
          const visible = visibleText(raw);
          cb.onThinking(!visible && raw.length > 0);
          if (visible.length > shown) {
            cb.onText(visible.slice(shown));
            shown = visible.length;
          }
        }
        for (const part of delta?.tool_calls ?? []) {
          const call = (calls[part.index ?? 0] ??= { id: '', name: '', args: '' });
          if (part.id) call.id = part.id;
          // The name normally arrives whole in the first fragment; some servers repeat it.
          if (part.function?.name && !call.name) call.name = part.function.name;
          if (part.function?.arguments) call.args += part.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } finally {
      cb.onThinking(false);
    }

    let text = visibleText(raw);
    const toolCalls: ToolCall[] = calls
      .filter((c) => c?.name)
      .map((c, i) => ({ id: c.id || `call_${step}_${i}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }));
    // Small local models sometimes write the call out as text ("search_book {"query": …}", or their
    // own <tool_call> markup) and the server passes it on as an answer. Taken for what it is, it runs.
    if (useTools && !toolCalls.length && text) {
      const written = parseWrittenCall(text, specs.map((s) => s.name));
      if (written) {
        cb.onStepDiscard();
        toolCalls.push({ id: `call_${step}_text`, type: 'function', function: written });
        text = '';
      }
    }

    if (finish === 'content_filter' && !text && !toolCalls.length) {
      return { status: 'refused', messages: opts.history };
    }

    messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

    if (!toolCalls.length) {
      // Small models often stop at announcing what they are about to do ("Let me look that up…").
      // Once per turn they are asked to go ahead instead of the reader being left with the promise.
      // Others fall silent after reading the tool results; they are asked for the answer.
      const silent = !text.trim() && step > 0;
      if (useTools && !nudged && (silent || looksLikePromise(text))) {
        nudged = true;
        messages.push({
          role: 'user',
          content: silent
            ? 'Now answer my question from what the tools returned, citing where in the book it is.'
            : 'Go ahead now: call the tools you need, then give the answer itself. Do not describe what you are going to do.',
        });
        continue;
      }
      return {
        status: finish === 'length' ? 'truncated' : 'done',
        messages,
        toolsUnsupported,
        note: toolsUnsupported
          ? 'Ця модель не вміє користуватися інструментами, тож бачить лише текст поточної сторінки. Щоб агент сам читав і шукав по книзі, оберіть модель із підтримкою інструментів.'
          : undefined,
      };
    }
    if (finish === 'length') throw new Error('Відповідь обірвалася посеред звернення до книги. Спробуйте ще раз.');

    const images: ContentPart[] = [];
    for (const call of toolCalls) {
      let result: ToolCallResult;
      try {
        const input: unknown = JSON.parse(call.function.arguments);
        result = await runTool(call.function.name, input, env, (label) => cb.onToolStart(call.id, label));
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        // Arguments that are not valid JSON go back to the model as an error, never to the tool.
        cb.onToolStart(call.id, call.function.name);
        result = { ok: false, output: { text: JSON.stringify({ INVALID_JSON: call.function.arguments }) } };
      }
      const { ok, output } = result;
      cb.onToolEnd(call.id, ok);
      // Tool messages are text-only in this API; an image follows in a user message.
      messages.push({ role: 'tool', tool_call_id: call.id, content: output.image ? `${output.text} The image is attached in the next message.` : output.text });
      if (output.image) {
        images.push({ type: 'text', text: output.text }, { type: 'image_url', image_url: { url: `data:${output.image.mediaType};base64,${output.image.data}` } });
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    }
    if (images.length) messages.push({ role: 'user', content: images });
  }

  throw new Error('Агент зробив забагато кроків і був зупинений. Спробуйте уточнити запит.');
}

/** Turns a failure of an OpenAI-compatible server into a message for the reader, or `null` if it is not one. */
export function describeOpenAiError(err: unknown, provider: OpenAiProvider): string | null {
  const local = provider.id === 'local';
  if (err instanceof DOMException && err.name === 'AbortError') return 'Зупинено.';
  if (provider.id === 'browser') {
    const reason = err instanceof Error ? err.message : String(err);
    if (/context window|ContextWindowSize/i.test(reason)) return 'Запит не вмістився в пам’ять цієї моделі. Почніть нову розмову або оберіть коротший фрагмент.';
    return `Модель у браузері не змогла відповісти: ${reason}`;
  }
  if (err instanceof TypeError && isBlockedMixedContent(provider.baseUrl)) return `Не вдалося з’єднатися з ${provider.baseUrl}. ${MIXED_CONTENT_HINT}`;
  if (err instanceof TypeError && !local && !isOpenRouter(provider.baseUrl)) {
    return `Не вдалося з’єднатися з ${provider.baseUrl}. Перевірте адресу й інтернет; сервіс також має дозволяти запити з браузера (CORS).`;
  }
  if (err instanceof TypeError) {
    // fetch() rejects with a TypeError when the server is unreachable or blocks the request (CORS).
    return local
      ? `Не вдалося з’єднатися з ${provider.baseUrl}. Перевірте, що сервер моделей запущено і що він дозволяє запити з цього сайту (для Ollama — змінна OLLAMA_ORIGINS).`
      : 'Немає з’єднання з OpenRouter. Перевірте інтернет і спробуйте ще раз.';
  }
  if (!(err instanceof ProviderError)) return null;
  switch (err.status) {
    case 401:
    case 403:
      return local ? `Сервер моделей відхилив запит (${err.status}): ${err.message}` : 'Ключ OpenRouter недійсний або не має доступу. Перевірте його в налаштуваннях AI.';
    case 402:
      return 'На рахунку OpenRouter недостатньо коштів для цієї моделі. Оберіть безкоштовну модель або поповніть баланс.';
    case 404:
      return local
        ? `Модель «${provider.model}» не знайдено на сервері. Для Ollama завантажте її командою: ollama pull ${provider.model}`
        : `OpenRouter не знайшов модель або постачальника: ${err.message}`;
    case 429:
      return local ? `Сервер моделей перевантажений: ${err.message}` : 'Перевищено ліміт запитів OpenRouter (у безкоштовних моделей він невеликий). Зачекайте трохи або оберіть іншу модель.';
    default:
      return `${local ? 'Сервер моделей' : 'OpenRouter'} повернув помилку (${err.status}): ${err.message}`;
  }
}
