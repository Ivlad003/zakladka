// A single short piece of text from the model, for filling in a field of the app: the draft of a
// note, the question of a study card. It goes through the same provider and the same book tools as
// the chat, but leaves no conversation behind.
import { getSettings } from '../settings';
import { languageRule } from './agents';
import { resolveProvider } from './providers';
import { describeError, runAgentTurn } from './run';
import type { AgentContext } from './tools';

/** `task` says what to write; `quote` is the text the reader selected, if any. */
export type AiFill = (task: string, quote?: string) => Promise<string>;

export async function quickFill(ctx: AgentContext, task: string, quote?: string): Promise<string> {
  const settings = getSettings();
  const resolved = resolveProvider(settings);
  if (!('provider' in resolved)) throw new Error(resolved.missing);
  const provider = resolved.provider;
  let text = '';
  try {
    const result = await runAgentTurn({
      provider,
      system: () =>
        `You fill in one field of a reading app for its user, who has the book "${ctx.book.title}" open. Reply with the text for that field and nothing else: no preamble, no quotation marks around it, no headings, no closing remark. The reader's message starts with a <reading_context> block the app adds — where they are in the book and the text they have selected; ground what you write in it, and in the book itself if you can read it. ${languageRule(settings.aiLanguage)}`,
      history: [],
      userText: task,
      quote,
      ctx,
      signal: new AbortController().signal,
      callbacks: {
        onStepStart: () => {},
        // A step that is being retried has produced nothing that should be kept.
        onStepDiscard: () => (text = ''),
        onThinking: () => {},
        onText: (delta) => (text += delta),
        onToolStart: () => {},
        onToolEnd: () => {},
      },
    });
    if (result.status === 'refused') throw new Error('Модель відмовилася відповідати на цей запит.');
  } catch (err) {
    throw new Error(describeError(err, provider));
  }
  if (!text.trim()) throw new Error('Модель нічого не відповіла. Спробуйте ще раз.');
  return text.trim();
}
