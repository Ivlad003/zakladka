// One piece of writing from the model, with nothing else around it: no conversation, no tools, no
// book open. Used where the app writes something long by itself — the chapters of a book made from
// a repository (lib/repo-book.ts). It goes through whichever provider the reader has set up.
import Anthropic from '@anthropic-ai/sdk';
import { FALLBACK_BETA } from './anthropic';
import { browserChat } from './browser-llm';
import { readEvents, visibleText, type StreamChunk } from './openai';
import { authHeaders, isOpenRouter, ProviderError, readErrorMessage, type ChatProvider } from './providers';
import { describeError } from './run';
import { duringWork } from '../lib/busy';

export interface CompleteOptions {
  system: string;
  user: string;
  signal: AbortSignal;
  /** Called while the text arrives, with how many characters there are so far. */
  onProgress?(chars: number): void;
}

export interface Completion {
  text: string;
  /** The model ran out of room before it finished. */
  truncated: boolean;
}

/** Raised when the model declined to write; retrying the same request would not help. */
export class RefusedError extends Error {}

async function viaClaude(provider: Extract<ChatProvider, { kind: 'anthropic' }>, opts: CompleteOptions): Promise<Completion> {
  const client = new Anthropic({
    apiKey: provider.apiKey,
    dangerouslyAllowBrowser: true,
    baseURL: provider.baseUrl || (import.meta.env.DEV && localStorage.getItem('zakladka:devApiBase')) || undefined,
  });
  // Claude Haiku 5.5 has no server-side refusal fallback (see anthropic.ts).
  const useFallback = !provider.model.startsWith('claude-haiku');
  const stream = client.beta.messages.stream(
    {
      model: provider.model,
      max_tokens: 32000,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      ...(useFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    },
    { signal: opts.signal },
  );
  let chars = 0;
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') opts.onProgress?.((chars += event.delta.text.length));
  }
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new RefusedError(message.stop_details?.explanation ?? 'Модель відмовилася це писати.');
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, truncated: message.stop_reason === 'max_tokens' };
}

async function viaOpenAi(provider: Extract<ChatProvider, { kind: 'openai' }>, opts: CompleteOptions): Promise<Completion> {
  const messages = [
    { role: 'system' as const, content: opts.system },
    { role: 'user' as const, content: opts.user },
  ];
  let events: AsyncIterable<StreamChunk>;
  if (provider.id === 'browser') {
    events = await browserChat(provider.model, messages, opts.signal);
  } else {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(provider.apiKey, isOpenRouter(provider.baseUrl) ? 'openrouter' : 'local'),
      signal: opts.signal,
      body: JSON.stringify({ model: provider.model, messages, stream: true }),
    });
    if (!res.ok) throw new ProviderError(res.status, await readErrorMessage(res), provider.id);
    events = readEvents(res);
  }
  let raw = '';
  let finish: string | null = null;
  for await (const chunk of events) {
    if (chunk.error) throw new ProviderError(Number(chunk.error.code) || 500, chunk.error.message ?? 'Помилка сервера моделі', provider.id);
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) {
      raw += choice.delta.content;
      opts.onProgress?.(visibleText(raw).length);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  const text = visibleText(raw);
  if (finish === 'content_filter' && !text.trim()) throw new RefusedError('Модель відмовилася це писати.');
  return { text, truncated: finish === 'length' };
}

/** Asks the model for one text. Failures come back as messages a reader can act on. */
export async function complete(provider: ChatProvider, opts: CompleteOptions): Promise<Completion> {
  try {
    // A text being written must not be cut off by the app updating itself.
    const result = await duringWork(provider.kind === 'anthropic' ? viaClaude(provider, opts) : viaOpenAi(provider, opts));
    if (!result.text.trim()) throw new Error('Модель нічого не відповіла.');
    return result;
  } catch (err) {
    if (err instanceof RefusedError) throw err;
    throw new Error(describeError(err, provider), { cause: err });
  }
}
