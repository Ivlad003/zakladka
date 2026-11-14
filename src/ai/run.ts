import { describeAnthropicError, runAnthropicTurn } from './anthropic';
import { describeOpenAiError, runOpenAiTurn } from './openai';
import type { ChatProvider } from './providers';
import type { RunOptions, RunResult } from './types';
import { duringWork } from '../lib/busy';
import type { UiMessage } from '../types';

/** Runs one user turn to completion with whichever provider the reader has configured. */
export function runAgentTurn(opts: RunOptions): Promise<RunResult> {
  // An answer in progress must not be cut off by the app updating itself.
  return duringWork(opts.provider.kind === 'anthropic' ? runAnthropicTurn(opts, opts.provider) : runOpenAiTurn(opts, opts.provider));
}

/** Turns a provider or network failure into a message for the reader. */
export function describeError(err: unknown, provider: ChatProvider): string {
  const known = provider.kind === 'anthropic' ? describeAnthropicError(err) : describeOpenAiError(err, provider);
  return known ?? (err instanceof Error ? err.message : String(err));
}

/**
 * Rebuilds a provider-neutral history from the visible transcript. Used when the reader switches
 * between Claude and an OpenAI-compatible provider mid-conversation: the stored wire-format history
 * of one cannot be replayed to the other, but plain user/assistant text can.
 */
export function plainHistory(ui: UiMessage[]): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of ui) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.quote ? `Selected text:\n"""\n${m.quote}\n"""\n\n${m.text}` : m.text });
      continue;
    }
    const text = m.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim();
    // A turn that produced no answer (stopped, failed) would leave two user messages in a row.
    if (text) out.push({ role: 'assistant', content: text });
    else out.pop();
  }
  return out;
}
