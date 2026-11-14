// Computes text embeddings on this device with transformers.js (ONNX Runtime Web).
//
// The library is loaded from its CDN build the first time embeddings are needed, not bundled:
// its npm package drags in the whole ONNX Runtime (well over 100 MB), which is far more than the
// reader itself. The version is pinned; the service worker keeps the files for offline use, and
// transformers.js caches the model weights itself.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

/** `model` is a Hugging Face id of a feature-extraction model that ships ONNX weights. */
export type EmbedRequest = { id: number; model: string; texts: string[] };
export type EmbedResponse =
  | { id: number; ok: true; dims: number; data: Float32Array }
  | { id: number; ok: false; error: string }
  | { id: -1; progress: { file: string; loaded: number; total: number } };

type Extractor = (texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

interface TransformersModule {
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: { dtype: 'q8'; progress_callback(p: { status: string; file?: string; loaded?: number; total?: number }): void },
  ): Promise<Extractor>;
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<EmbedRequest>) => void) | null;
  postMessage(message: EmbedResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
/** One model at a time: switching models in the settings replaces the loaded one. */
let loaded: { model: string; extractor: Promise<Extractor> } | null = null;

function load(model: string): Promise<Extractor> {
  if (loaded?.model === model) return loaded.extractor;
  const extractor = (async () => {
    const transformers = (await import(/* @vite-ignore */ TRANSFORMERS_URL)) as TransformersModule;
    return transformers.pipeline('feature-extraction', model, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.file && p.total) {
          scope.postMessage({ id: -1, progress: { file: p.file, loaded: p.loaded ?? 0, total: p.total } });
        }
      },
    });
  })();
  loaded = { model, extractor };
  // A failed download must not poison every later attempt.
  extractor.catch(() => {
    if (loaded?.extractor === extractor) loaded = null;
  });
  return extractor;
}

scope.onmessage = async (e) => {
  const { id, texts } = e.data;
  try {
    const extract = await load(e.data.model);
    const output = await extract(texts, { pooling: 'mean', normalize: true });
    const data = new Float32Array(output.data);
    scope.postMessage({ id, ok: true, dims: output.dims[output.dims.length - 1], data }, [data.buffer]);
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
