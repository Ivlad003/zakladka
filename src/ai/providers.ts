import { MODELS, OPENROUTER_URL, type ContextSize, type Settings } from '../settings';
import { findBrowserModel } from './browser-llm';

/** Raised for any non-2xx answer (or in-stream error) from an OpenAI-compatible server. */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly provider: 'openrouter' | 'local' | 'browser',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type ChatProvider =
  | { kind: 'anthropic'; name: string; apiKey: string; model: string; /** Empty = api.anthropic.com. */ baseUrl: string; readLimit: number }
  | {
      kind: 'openai';
      /** `browser`: a model running in this browser through WebLLM; it has no address and no key. */
      id: 'openrouter' | 'local' | 'browser';
      name: string;
      baseUrl: string;
      apiKey: string;
      model: string;
      /** Whether to offer the book tools; when false the current page is sent with every message instead. */
      tools: boolean;
      vision: boolean;
      readLimit: number;
    };

/** Characters of book text per tool call. Cyrillic costs roughly one token per 2–3 characters. */
const READ_LIMITS: Record<ContextSize, number> = { small: 4_000, medium: 12_000, large: 40_000 };

export const trimUrl = (url: string) => url.trim().replace(/\/+$/, '');

export const isOpenRouter = (url: string) => /^https:\/\/openrouter\.ai(\/|$)/i.test(url.trim());

/**
 * A page served over HTTPS may not call plain-HTTP addresses, except on the device itself.
 * That is what stops an installed app on a phone from reaching a model server on the home network.
 */
export function isBlockedMixedContent(url: string): boolean {
  if (location.protocol !== 'https:' || !/^http:/i.test(url.trim())) return false;
  return !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url.trim());
}

export const MIXED_CONTENT_HINT =
  'Застосунок відкрито через HTTPS, тому браузер не пускає запити на адресу http://. Відкрийте сервер через HTTPS (наприклад, Tailscale Serve) або запускайте застосунок і сервер за однією адресою.';

export function resolveProvider(s: Settings): { provider: ChatProvider } | { missing: string } {
  switch (s.aiProvider) {
    case 'anthropic': {
      if (!s.apiKey) return { missing: 'Додайте ключ Claude API, щоб агенти запрацювали.' };
      const model = s.model.trim();
      if (!model) return { missing: 'Вкажіть модель Claude у налаштуваннях AI.' };
      const name = MODELS.find((m) => m.id === model)?.name ?? model;
      return { provider: { kind: 'anthropic', name, apiKey: s.apiKey, model, baseUrl: trimUrl(s.anthropicBaseUrl), readLimit: 60_000 } };
    }
    case 'openrouter': {
      if (!s.openrouterKey) return { missing: 'Додайте ключ OpenRouter (він потрібен і для безкоштовних моделей).' };
      if (!s.openrouterModel) return { missing: 'Оберіть модель OpenRouter у налаштуваннях AI.' };
      const baseUrl = trimUrl(s.openrouterBaseUrl) || OPENROUTER_URL;
      return {
        provider: {
          kind: 'openai',
          id: 'openrouter',
          name: `${isOpenRouter(baseUrl) ? 'OpenRouter' : hostOf(baseUrl)} · ${s.openrouterModel}`,
          baseUrl,
          apiKey: s.openrouterKey,
          model: s.openrouterModel,
          tools: s.openrouterTools,
          vision: s.openrouterVision,
          readLimit: 24_000,
        },
      };
    }
    case 'local': {
      if (!trimUrl(s.localBaseUrl)) return { missing: 'Вкажіть адресу локального сервера моделей у налаштуваннях AI.' };
      if (!s.localModel) return { missing: 'Оберіть локальну модель у налаштуваннях AI.' };
      return {
        provider: {
          kind: 'openai',
          id: 'local',
          name: `Локально · ${s.localModel}`,
          baseUrl: trimUrl(s.localBaseUrl),
          apiKey: s.localApiKey,
          model: s.localModel,
          tools: s.localTools,
          vision: s.localVision,
          readLimit: READ_LIMITS[s.localContext],
        },
      };
    }
    case 'browser': {
      if (!s.browserModel) return { missing: 'Оберіть у налаштуваннях AI модель, яка працюватиме в браузері.' };
      return {
        provider: {
          kind: 'openai',
          id: 'browser',
          name: `У браузері · ${findBrowserModel(s.browserModel)?.name ?? s.browserModel}`,
          baseUrl: '',
          apiKey: '',
          model: s.browserModel,
          // These small models are given the page they need rather than tools to fetch it.
          tools: false,
          vision: false,
          readLimit: 2_400,
        },
      };
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function authHeaders(apiKey: string, provider: 'openrouter' | 'local' | 'embed'): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  // Shown on the OpenRouter activity page; carries no personal data.
  if (provider === 'openrouter') headers['X-Title'] = 'Zakladka Reader';
  return headers;
}

/** Reads the error text out of the many shapes OpenAI-compatible servers use. */
export async function readErrorMessage(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const json = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    const message = typeof json.error === 'string' ? json.error : (json.error?.message ?? json.message);
    if (message) return message;
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return raw.slice(0, 400) || res.statusText || `HTTP ${res.status}`;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  free?: boolean;
  tools?: boolean;
  vision?: boolean;
  /** USD per million tokens. */
  priceIn?: number;
  priceOut?: number;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
}

/**
 * The model catalogue of OpenRouter (public, no key needed) or of another OpenAI-compatible cloud
 * service set as the address (those usually want the key). Free models first.
 */
export async function listOpenRouterModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const base = trimUrl(baseUrl) || OPENROUTER_URL;
  const res = await fetch(`${base}/models`, { headers: isOpenRouter(base) || !apiKey ? undefined : { Authorization: `Bearer ${apiKey}` }, signal });
  if (!res.ok) throw new ProviderError(res.status, await readErrorMessage(res), 'openrouter');
  const { data } = (await res.json()) as { data: OpenRouterModel[] };
  return data
    .map((m): ModelInfo => {
      const priceIn = Number(m.pricing?.prompt ?? NaN) * 1e6;
      const priceOut = Number(m.pricing?.completion ?? NaN) * 1e6;
      return {
        id: m.id,
        name: m.name ?? m.id,
        contextLength: m.context_length,
        free: priceIn === 0 && priceOut === 0,
        tools: m.supported_parameters?.includes('tools') ?? false,
        vision: m.architecture?.input_modalities?.includes('image') ?? false,
        priceIn: Number.isFinite(priceIn) ? priceIn : undefined,
        priceOut: Number.isFinite(priceOut) ? priceOut : undefined,
      };
    })
    .sort((a, b) => Number(b.free) - Number(a.free) || a.name.localeCompare(b.name));
}

/** Models installed on a local OpenAI-compatible server (`GET /models`). */
export async function listLocalModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const res = await fetch(`${trimUrl(baseUrl)}/models`, { headers: authHeaders(apiKey, 'local'), signal });
  if (!res.ok) throw new ProviderError(res.status, await readErrorMessage(res), 'local');
  let json: { data?: { id: string }[] };
  try {
    json = await res.json();
  } catch {
    // Something answered, but not an OpenAI-style API (a web page, for instance).
    throw new ProviderError(res.status, 'за цією адресою немає OpenAI-сумісного API (зазвичай адреса закінчується на /v1)', 'local');
  }
  return (json.data ?? []).map((m) => ({ id: m.id, name: m.id })).sort((a, b) => a.id.localeCompare(b.id));
}
