// A language model that runs inside the browser. Nothing leaves the device, and after the first
// download it works offline. Two runtimes, because phones differ:
//
//   • "cpu" — wllama (llama.cpp compiled to WebAssembly). Runs on the processor, so it works in any
//     current browser, including Safari on an iPhone that has no WebGPU. Slower; meant for the
//     smallest models.
//   • "gpu" — WebLLM. Runs on the graphics chip through WebGPU: much faster, and the way to run the
//     larger models on a computer, but the browser has to support WebGPU.
//
// Both libraries are loaded from their CDN builds the first time they are needed, with the version
// pinned; the model weights are downloaded once from Hugging Face and kept in the browser's storage.
import { useSyncExternalStore } from 'react';
import { holdWork } from '../lib/busy';

const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.88/+esm';
const WLLAMA_URL = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.13.0/esm/index.js';
const WLLAMA_WASM = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.13.0/esm/wasm/wllama.wasm';

export interface BrowserModel {
  id: string;
  engine: 'cpu' | 'gpu';
  name: string;
  /** Download size for "cpu" models, graphics memory for "gpu" ones, in gigabytes. */
  gb: number;
  note: string;
  /** "cpu": where the GGUF file lives on Hugging Face. */
  repo?: string;
  file?: string;
  /** "gpu": the same model for graphics chips without 16-bit float shaders. */
  f32?: string;
}

export const BROWSER_MODELS: BrowserModel[] = [
  // Processor: any phone or computer.
  { id: 'cpu:qwen2.5-0.5b', engine: 'cpu', name: 'Qwen 2.5 0.5B', gb: 0.47, note: 'найлегша, багатомовна — для будь-якого телефона', repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf' },
  { id: 'cpu:gemma-3-1b', engine: 'cpu', name: 'Gemma 3 1B', gb: 0.77, note: 'краще розуміє українську; повільніша', repo: 'ggml-org/gemma-3-1b-it-GGUF', file: 'gemma-3-1b-it-Q4_K_M.gguf' },
  { id: 'cpu:qwen2.5-1.5b', engine: 'cpu', name: 'Qwen 2.5 1.5B', gb: 1.07, note: 'розумніша; для нового телефона чи ноутбука', repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf' },
  // Graphics chip (WebGPU).
  { id: 'gemma3-1b-it-q4f16_1-MLC', engine: 'gpu', name: 'Gemma 3 1B', gb: 0.7, note: 'багатомовна, швидка — для телефона з WebGPU' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', engine: 'gpu', name: 'Llama 3.2 1B', gb: 0.9, note: 'легка', f32: 'Llama-3.2-1B-Instruct-q4f32_1-MLC' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', engine: 'gpu', name: 'Qwen 2.5 1.5B', gb: 1.6, note: 'легка, багатомовна', f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
  { id: 'Qwen3.5-2B-q4f16_1-MLC', engine: 'gpu', name: 'Qwen 3.5 2B', gb: 2.2, note: 'міркує перед відповіддю' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', engine: 'gpu', name: 'Llama 3.2 3B', gb: 2.3, note: 'для планшета чи ноутбука' },
  { id: 'Qwen3.5-4B-q4f16_1-MLC', engine: 'gpu', name: 'Qwen 3.5 4B', gb: 3.9, note: 'добрий баланс для комп’ютера' },
  { id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', engine: 'gpu', name: 'Qwen 2.5 7B', gb: 5.1, note: 'для відеокарти від 8 ГБ' },
  { id: 'Qwen3.5-9B-q4f16_1-MLC', engine: 'gpu', name: 'Qwen 3.5 9B', gb: 6.4, note: 'найсильніша зі списку' },
];

export const findBrowserModel = (id: string): BrowserModel | undefined => BROWSER_MODELS.find((m) => m.id === id);
export const webGpuAvailable = (): boolean => typeof navigator !== 'undefined' && 'gpu' in navigator;

/** Whether a model can run in this browser at all. */
export const canRun = (model: BrowserModel): boolean => model.engine === 'cpu' || webGpuAvailable();

interface Chunk {
  choices?: { finish_reason?: string | null; delta?: { content?: string | null } }[];
}

type Message = { role: string; content: unknown };

/** What both runtimes come down to once a model is loaded. */
interface Running {
  chat(messages: Message[], signal: AbortSignal): Promise<AsyncIterable<Chunk>>;
  unload(): Promise<void>;
}

// ---- WebLLM (graphics chip) ----
interface WebLlm {
  CreateMLCEngine(
    model: string,
    config: { initProgressCallback(report: { progress: number; text: string }): void },
  ): Promise<{
    chat: { completions: { create(request: { messages: unknown[]; stream: true; temperature?: number }): Promise<AsyncIterable<Chunk>> } };
    interruptGenerate(): void;
    unload(): Promise<void>;
  }>;
  hasModelInCache(model: string): Promise<boolean>;
  deleteModelAllInfoInCache(model: string): Promise<void>;
}

let webllmLib: Promise<WebLlm> | null = null;
const webllm = () => (webllmLib ??= import(/* @vite-ignore */ WEBLLM_URL) as Promise<WebLlm>);

/** The variant of a "gpu" model this graphics chip can run: some lack 16-bit float shaders. */
async function gpuVariant(model: BrowserModel): Promise<string> {
  if (!model.f32) return model.id;
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: { has(name: string): boolean } } | null> } }).gpu;
    const adapter = await gpu?.requestAdapter();
    return adapter && !adapter.features.has('shader-f16') ? model.f32 : model.id;
  } catch {
    return model.id;
  }
}

async function startGpu(model: BrowserModel, report: (progress: number, text: string) => void): Promise<Running> {
  if (!webGpuAvailable()) throw new Error('Цей браузер не підтримує WebGPU. Оберіть модель «на процесорі» — вона працює всюди.');
  const lib = await webllm();
  const engine = await lib.CreateMLCEngine(await gpuVariant(model), { initProgressCallback: (r) => report(r.progress, r.text) });
  return {
    async chat(messages, signal) {
      const stop = () => engine.interruptGenerate();
      signal.addEventListener('abort', stop, { once: true });
      const stream = await engine.chat.completions.create({ messages, stream: true, temperature: 0.6 });
      return (async function* () {
        try {
          for await (const chunk of stream) yield chunk;
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        } finally {
          signal.removeEventListener('abort', stop);
        }
      })();
    },
    unload: () => engine.unload(),
  };
}

// ---- wllama (processor) ----
interface WllamaModel {
  url: string;
  size: number;
  remove(): Promise<void>;
}

interface Wllama {
  modelManager: { getModels(): Promise<WllamaModel[]> };
  loadModelFromHF(source: { repo: string; file: string }, params: { n_ctx: number; progressCallback(p: { loaded: number; total: number }): void }): Promise<void>;
  createChatCompletion(options: { messages: unknown[]; stream: true; temperature: number; max_tokens: number; abortSignal: AbortSignal }): Promise<AsyncIterable<Chunk>>;
  exit(): Promise<void>;
}

interface WllamaLib {
  Wllama: new (paths: { default: string }, config: { suppressNativeLog: boolean; allowOffline: boolean }) => Wllama;
}

let wllamaLib: Promise<WllamaLib> | null = null;
const newWllama = async (): Promise<Wllama> => {
  const lib = await (wllamaLib ??= import(/* @vite-ignore */ WLLAMA_URL) as Promise<WllamaLib>);
  return new lib.Wllama({ default: WLLAMA_WASM }, { suppressNativeLog: true, allowOffline: true });
};

const megabytes = (bytes: number) => `${Math.round(bytes / 1_048_576)} МБ`;

async function startCpu(model: BrowserModel, report: (progress: number, text: string) => void): Promise<Running> {
  const engine = await newWllama();
  await engine.loadModelFromHF(
    { repo: model.repo!, file: model.file! },
    {
      n_ctx: 4096,
      progressCallback: ({ loaded, total }) => report(total ? loaded / total : 0, total ? `Завантажую модель: ${megabytes(loaded)} з ${megabytes(total)}` : 'Завантажую модель…'),
    },
  );
  return {
    chat: (messages, signal) => engine.createChatCompletion({ messages, stream: true, temperature: 0.6, max_tokens: 900, abortSignal: signal }),
    unload: () => engine.exit(),
  };
}

// ---- One model at a time, with its state visible to the settings and the chat ----
export interface BrowserModelState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  model: string;
  /** 0..1 while loading. */
  progress: number;
  text: string;
}

let state: BrowserModelState = { status: 'idle', model: '', progress: 0, text: '' };
const listeners = new Set<() => void>();
const setState = (next: BrowserModelState) => {
  state = next;
  listeners.forEach((l) => l());
};

export function useBrowserModel(): BrowserModelState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

let loaded: { model: string; running: Promise<Running> } | null = null;

/** Makes the model ready: downloads it on first use, then loads it into memory. */
export function loadBrowserModel(id: string): Promise<Running> {
  if (loaded?.model === id) return loaded.running;
  const model = findBrowserModel(id);
  if (!model) return Promise.reject(new Error(`Невідома модель «${id}». Оберіть іншу в налаштуваннях AI.`));
  const previous = loaded?.running;
  const release = holdWork();
  setState({ status: 'loading', model: id, progress: 0, text: 'Завантажую бібліотеку…' });
  const report = (progress: number, text: string) => setState({ status: 'loading', model: id, progress, text });
  const running = (async () => {
    // A phone or a laptop does not hold two models in memory.
    await previous?.then((r) => r.unload()).catch(() => {});
    return model.engine === 'gpu' ? startGpu(model, report) : startCpu(model, report);
  })();
  loaded = { model: id, running };
  running
    .then(
      () => setState({ status: 'ready', model: id, progress: 1, text: '' }),
      (err) => {
        if (loaded?.running === running) loaded = null;
        setState({ status: 'error', model: id, progress: 0, text: err instanceof Error ? err.message : String(err) });
      },
    )
    .finally(release);
  return running;
}

const cpuFileUrl = (model: BrowserModel) => `${model.repo}/resolve/main/${model.file}`;

export async function isModelDownloaded(id: string): Promise<boolean> {
  const model = findBrowserModel(id);
  if (!model) return false;
  try {
    if (model.engine === 'gpu') return await (await webllm()).hasModelInCache(await gpuVariant(model));
    const known = await (await newWllama()).modelManager.getModels();
    return known.some((m) => m.url.includes(cpuFileUrl(model)) && m.size > 0);
  } catch {
    return false;
  }
}

/** Frees the space the model takes on the device. */
export async function deleteBrowserModel(id: string): Promise<void> {
  const model = findBrowserModel(id);
  if (!model) return;
  if (loaded?.model === id) {
    await loaded.running.then((r) => r.unload()).catch(() => {});
    loaded = null;
  }
  if (model.engine === 'gpu') await (await webllm()).deleteModelAllInfoInCache(await gpuVariant(model));
  else for (const m of await (await newWllama()).modelManager.getModels()) if (m.url.includes(cpuFileUrl(model))) await m.remove();
  setState({ status: 'idle', model: '', progress: 0, text: '' });
}

/**
 * These models see about 4,000 tokens at a time, so only the latest exchanges are sent, and the
 * page text that travelled with earlier questions is dropped — the current question brings its own.
 */
function compact(messages: Message[]): Message[] {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system').slice(-6);
  return [
    ...system,
    ...rest.map((m, i) =>
      m.role === 'user' && i < rest.length - 1 && typeof m.content === 'string' ? { ...m, content: m.content.replace(/^<reading_context>[\s\S]*?<\/reading_context>\s*/, '') } : m,
    ),
  ];
}

/** One streamed answer, in the same shape an OpenAI-compatible server sends it. */
export async function browserChat(model: string, messages: Message[], signal: AbortSignal): Promise<AsyncIterable<Chunk>> {
  const running = await loadBrowserModel(model);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return running.chat(compact(messages), signal);
}
