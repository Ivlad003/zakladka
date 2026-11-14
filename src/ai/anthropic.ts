import Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from './providers';
import { buildUserContent, getTools, runTool, type ToolEnv, type ToolOutput } from './tools';
import { MAX_STEPS, type RunOptions, type RunResult } from './types';

type ApiMessage = Anthropic.Beta.BetaMessageParam;

const MAX_JSON_RETRIES = 2;
/** Lets the API drop thinking blocks that no longer match the conversation instead of failing the request. */
const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';
/** On a safety-classifier decline the API re-runs the request on a fallback model within the same call. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function toResultContent(output: ToolOutput): Anthropic.Beta.BetaToolResultBlockParam['content'] {
  if (!output.image) return output.text;
  return [
    { type: 'image', source: { type: 'base64', media_type: output.image.mediaType, data: output.image.data } },
    { type: 'text', text: output.text },
  ];
}

/**
 * One user turn against the Claude API: streams the reply, runs the tools Claude asks for against
 * the open book, feeds the results back, and repeats until Claude is done.
 */
export async function runAnthropicTurn(opts: RunOptions, provider: Extract<ChatProvider, { kind: 'anthropic' }>): Promise<RunResult> {
  const { callbacks: cb, ctx, signal } = opts;
  const env: ToolEnv = { ctx, readLimit: provider.readLimit };
  // The user's own key, kept on their device; there is no backend to proxy through.
  const client = new Anthropic({
    apiKey: provider.apiKey,
    dangerouslyAllowBrowser: true,
    // A gateway or proxy from the settings; in development also the mock API defined in vite.config.ts.
    baseURL: provider.baseUrl || (import.meta.env.DEV && localStorage.getItem('zakladka:devApiBase')) || undefined,
  });
  // The tool list and the system prompt stay byte-stable for the whole thread (prompt caching).
  const tools: Anthropic.Beta.BetaTool[] = getTools({ vision: true, noBook: ctx.noBook }).map((t) => ({
    name: t.name,
    description: t.description(env),
    input_schema: t.parameters,
    eager_input_streaming: true,
  }));
  const system = opts.system(true);
  const userContent = await buildUserContent(ctx, opts.userText, opts.quote, null);
  const messages: ApiMessage[] = [...(opts.history as ApiMessage[]), { role: 'user', content: userContent }];
  // Claude Haiku 5.5 has no server-side refusal fallback.
  const useFallback = !provider.model.startsWith('claude-haiku');
  let jsonRetries = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    cb.onStepStart();
    const stream = client.beta.messages.stream(
      {
        model: provider.model,
        max_tokens: 64000,
        system,
        tools,
        messages,
        thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        betas: useFallback ? [THINKING_BINDING_BETA, FALLBACK_BETA] : [THINKING_BINDING_BETA],
        ...(useFallback ? { fallbacks: 'default' as const } : {}),
      },
      { signal },
    );

    let message: Anthropic.Beta.BetaMessage;
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          cb.onThinking(event.content_block.type === 'thinking' || event.content_block.type === 'redacted_thinking');
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          cb.onText(event.delta.text);
        }
      }
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // With eager input streaming a tool input can arrive as unparseable JSON: re-issue that request.
      // API errors and aborts are never retried here.
      if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= MAX_JSON_RETRIES) throw err;
      cb.onStepDiscard();
      continue;
    } finally {
      cb.onThinking(false);
    }

    // A refusal can cut a tool call off mid-input, so nothing from this turn is kept or executed.
    if (message.stop_reason === 'refusal') {
      return { status: 'refused', messages: opts.history, note: message.stop_details?.explanation ?? undefined };
    }

    messages.push({ role: 'assistant', content: message.content });
    if (message.stop_reason === 'pause_turn') continue;

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (!toolUses.length) {
      return { status: message.stop_reason === 'max_tokens' ? 'truncated' : 'done', messages };
    }
    // An input cut off by the token limit can still parse as a valid partial object — do not run it.
    if (message.stop_reason === 'max_tokens') {
      throw new Error('Відповідь обірвалася посеред звернення до книги. Спробуйте ще раз.');
    }

    // All results go back in a single user message, in order.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const { ok, output } = await runTool(use.name, use.input, env, (label) => cb.onToolStart(use.id, label));
      cb.onToolEnd(use.id, ok);
      results.push({ type: 'tool_result', tool_use_id: use.id, content: toResultContent(output), ...(ok ? {} : { is_error: true }) });
      if (signal.aborted) throw new Anthropic.APIUserAbortError();
    }
    messages.push({ role: 'user', content: results });
  }

  throw new Error('Агент зробив забагато кроків і був зупинений. Спробуйте уточнити запит.');
}

/** Turns a Claude SDK failure into a message for the reader, or `null` if it is not one. */
export function describeAnthropicError(err: unknown): string | null {
  if (err instanceof Anthropic.APIUserAbortError) return 'Зупинено.';
  if (err instanceof Anthropic.APIConnectionError) return 'Немає з’єднання з Claude API. Перевірте інтернет і спробуйте ще раз.';
  if (err instanceof Anthropic.AuthenticationError) return 'Ключ Claude API недійсний. Перевірте його в налаштуваннях AI.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Цей ключ не має доступу до вибраної моделі Claude.';
  if (err instanceof Anthropic.NotFoundError) return 'Вибрана модель Claude недоступна для цього ключа. Оберіть іншу в налаштуваннях AI.';
  if (err instanceof Anthropic.RateLimitError) return 'Забагато запитів або вичерпано ліміт Claude API. Зачекайте трохи й повторіть.';
  if (err instanceof Anthropic.BadRequestError) return `Claude API відхилив запит: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Помилка Claude API (${err.status ?? '—'}): ${err.message}`;
  return null;
}
