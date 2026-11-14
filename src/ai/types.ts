import type { ChatProvider } from './providers';
import type { AgentContext } from './tools';

export interface RunCallbacks {
  /** A new model request starts; anything emitted after this belongs to it. */
  onStepStart(): void;
  /** The current request failed before completing and will be re-issued: drop what it emitted. */
  onStepDiscard(): void;
  onThinking(active: boolean): void;
  onText(delta: string): void;
  onToolStart(id: string, label: string): void;
  onToolEnd(id: string, ok: boolean): void;
}

export interface RunOptions {
  provider: ChatProvider;
  /** Builds the system prompt; `tools` is false for models that cannot call tools. */
  system(tools: boolean): string;
  /** Conversation so far in the provider's wire format; never mutated. */
  history: unknown[];
  userText: string;
  quote?: string;
  ctx: AgentContext;
  signal: AbortSignal;
  callbacks: RunCallbacks;
}

export interface RunResult {
  status: 'done' | 'truncated' | 'refused';
  /** History to keep for the next turn (unchanged when the turn was refused). */
  messages: unknown[];
  /** Something the reader should know about how the turn went. */
  note?: string;
  /** Set when the model turned out not to support tools, so the setting can be switched off. */
  toolsUnsupported?: boolean;
}

export const MAX_STEPS = 30;
