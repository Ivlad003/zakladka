import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = fileURLToPath(new URL('.', import.meta.url));

/** Dev only: serves test books from ./dev-samples at /__samples/<file>. */
function devSamples(): Plugin {
  return {
    name: 'dev-samples',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__samples', (req, res, next) => {
        const name = path.basename(decodeURIComponent((req.url ?? '').split('?')[0]));
        const file = path.join(root, 'dev-samples', name);
        if (!name || !fs.existsSync(file)) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

/**
 * Dev only: a tiny stand-in for the Claude Messages API at /__mock_anthropic, used to exercise the
 * agent loop without a real key. Enable it in the browser console:
 *   localStorage.setItem('zakladka:devApiBase', location.origin + '/__mock_anthropic')
 * A message of the form `tool:<name> {json}` makes the mock call that tool; anything else calls
 * search_book with the message text. The follow-up turn echoes the tool result back as text.
 * The last request (headers + body) is written to dev-samples/.last-request.json.
 */
function mockAnthropic(): Plugin {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Block = { type: string; text?: string; content?: unknown };
  return {
    name: 'mock-anthropic',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__mock_anthropic', (req, res) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', async () => {
          const body = JSON.parse(raw || '{}');
          fs.writeFileSync(
            path.join(root, 'dev-samples', '.last-request.json'),
            JSON.stringify({ url: req.url, headers: req.headers, body }, null, 2),
          );
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const send = async (type: string, data: object) => {
            res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
            await sleep(120);
          };
          const last = body.messages?.[body.messages.length - 1];
          const blocks: Block[] = typeof last?.content === 'string' ? [{ type: 'text', text: last.content }] : (last?.content ?? []);
          const toolResult = blocks.find((b) => b.type === 'tool_result');
          const empty = String();

          await send('message_start', {
            message: {
              id: 'msg_mock',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          });
          await send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: empty, signature: empty } });
          await sleep(500);
          await send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'mock-signature' } });
          await send('content_block_stop', { index: 0 });

          if (toolResult) {
            const shown = typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content).slice(0, 300);
            const answer = `**Результат інструмента** (імітація API):\n\n${shown.slice(0, 1800)}`;
            await send('content_block_start', { index: 1, content_block: { type: 'text', text: empty } });
            for (let i = 0; i < answer.length; i += 60) {
              await send('content_block_delta', { index: 1, delta: { type: 'text_delta', text: answer.slice(i, i + 60) } });
            }
            await send('content_block_stop', { index: 1 });
            await send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } });
          } else {
            const text = (blocks.find((b) => b.type === 'text')?.text ?? empty).split('</reading_context>').pop()!.trim();
            const m = /^tool:(\w+)\s*(\{.*\})?$/s.exec(text);
            const name = m ? m[1] : 'search_book';
            const input = m ? (m[2] ?? '{}') : JSON.stringify({ query: text });
            await send('content_block_start', { index: 1, content_block: { type: 'tool_use', id: `toolu_mock_${Date.now()}`, name, input: {} } });
            const half = Math.ceil(input.length / 2);
            await send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: input.slice(0, half) } });
            await send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: input.slice(half) } });
            await send('content_block_stop', { index: 1 });
            await send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
          }
          await send('message_stop', {});
          res.end();
        });
      });
    },
  };
}

/**
 * Dev only: a stand-in for an OpenAI-compatible server (Ollama, LM Studio, OpenRouter) at
 * /__mock_openai/v1, to exercise the local-model code path without one running. Point the
 * "local models" provider (or the embeddings server) at `${location.origin}/__mock_openai/v1`.
 * - GET  /models            two models: `mock-tools` and `mock-no-tools`
 * - POST /chat/completions  `mock-no-tools` rejects requests that carry tools, the way Ollama does;
 *                           otherwise `tool:<name> {json}` calls that tool (default: search_book)
 *                           and the follow-up turn echoes the tool result
 * - POST /embeddings        deterministic character-trigram vectors (lexical, but good enough to test with)
 */
function mockOpenAi(): Plugin {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Msg = { role: string; content: string | { type: string; text?: string }[] | null };
  const textOf = (m?: Msg) => (typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p) => p.text ?? `[${p.type}]`).join(' '));
  const embed = (text: string) => {
    const v = new Array<number>(96).fill(0);
    const s = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
    for (let i = 0; i + 3 <= s.length; i++) {
      let h = 2166136261;
      for (let j = i; j < i + 3; j++) h = Math.imul(h ^ s.charCodeAt(j), 16777619);
      v[(h >>> 0) % v.length] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  return {
    name: 'mock-openai',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__mock_openai/v1', (req, res) => {
        const json = (status: number, data: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        if (req.method === 'GET' && req.url?.startsWith('/models')) {
          return json(200, { object: 'list', data: [{ id: 'mock-tools' }, { id: 'mock-no-tools' }] });
        }
        let raw = String();
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', async () => {
          const body = JSON.parse(raw || '{}');
          if (req.url?.startsWith('/embeddings')) {
            const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
            return json(200, { object: 'list', model: body.model, data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: embed(t) })) });
          }
          fs.writeFileSync(path.join(root, 'dev-samples', '.last-openai-request.json'), JSON.stringify({ url: req.url, headers: req.headers, body }, null, 2));
          if (body.model === 'mock-no-tools' && body.tools) {
            return json(400, { error: { message: 'registry.ollama.ai/library/mock-no-tools does not support tools', type: 'api_error' } });
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const send = async (delta: object, finish: string | null = null) => {
            res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
            await sleep(90);
          };
          const messages: Msg[] = body.messages ?? [];
          const last = messages[messages.length - 1];
          const say = async (answer: string) => {
            for (let i = 0; i < answer.length; i += 50) await send({ content: answer.slice(i, i + 50) });
            await send({}, 'stop');
          };
          await send({ role: 'assistant', content: '<think>mock reasoning</think>' });
          if (last?.role === 'tool' || messages[messages.length - 2]?.role === 'tool') {
            const result = [...messages].reverse().find((m) => m.role === 'tool');
            await say(`**Результат інструмента** (імітація локальної моделі):\n\n${textOf(result).slice(0, 1500)}`);
          } else if (body.tools) {
            const text = textOf(last).split('</reading_context>').pop()!.trim();
            const m = /^tool:(\w+)\s*(\{.*\})?$/s.exec(text);
            const args = m ? (m[2] ?? '{}') : JSON.stringify({ query: text });
            const half = Math.ceil(args.length / 2);
            await send({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: m ? m[1] : 'search_book', arguments: args.slice(0, half) } }] });
            await send({ tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] });
            await send({}, 'tool_calls');
          } else {
            await say(`**Без інструментів** (імітація локальної моделі). Отримано:\n\n${textOf(last).slice(0, 700)}`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
    },
  };
}

/**
 * Dev only: an in-memory stand-in for S3-compatible storage (RustFS, MinIO) at /__mock_s3, to
 * exercise sync without a server. In the sync settings use `${origin}/__mock_s3` as the address
 * and any bucket name and keys; signatures are not checked. It answers cross-origin requests the
 * way a storage with CORS enabled does, so a second "device" can be the production preview on
 * another port. Everything is lost when the dev server restarts.
 */
function mockS3(): Plugin {
  const buckets = new Map<string, Map<string, { body: Buffer; type: string }>>();
  return {
    name: 'mock-s3',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__mock_s3', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, HEAD, DELETE');
        res.setHeader('Access-Control-Allow-Headers', String(req.headers['access-control-request-headers'] ?? '*'));
        res.setHeader('Access-Control-Max-Age', '600');
        if (req.method === 'OPTIONS') return void res.writeHead(204).end();

        const [bucketName, ...rest] = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '').split('/');
        const key = rest.join('/');
        const fail = (status: number, code: string, message: string) => {
          res.writeHead(status, { 'Content-Type': 'application/xml' });
          res.end(req.method === 'HEAD' ? undefined : `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);
        };
        if (!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')) return fail(403, 'AccessDenied', 'Request is not signed.');
        const bucket = buckets.get(bucketName);

        if (!key) {
          if (req.method === 'PUT') {
            if (!bucket) buckets.set(bucketName, new Map());
            return void res.writeHead(200).end();
          }
          return bucket ? void res.writeHead(200).end() : fail(404, 'NoSuchBucket', 'The specified bucket does not exist.');
        }
        if (!bucket) return fail(404, 'NoSuchBucket', 'The specified bucket does not exist.');

        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            bucket.set(key, { body: Buffer.concat(chunks), type: String(req.headers['content-type'] ?? 'application/octet-stream') });
            res.writeHead(200).end();
          });
          return;
        }
        if (req.method === 'DELETE') {
          bucket.delete(key);
          return void res.writeHead(204).end();
        }
        const object = bucket.get(key);
        if (!object) return fail(404, 'NoSuchKey', 'The specified key does not exist.');
        res.writeHead(200, { 'Content-Type': object.type, 'Content-Length': object.body.length });
        res.end(req.method === 'HEAD' ? undefined : object.body);
      });
    },
  };
}

export default defineConfig({
  // When this build was made: shown in the settings, so a reader can tell which version a device runs.
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  // djvu-rs locates its .wasm through import.meta.url, which dependency pre-bundling would break.
  optimizeDeps: { exclude: ["djvu-rs"] },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  plugins: [
    react(),
    devSamples(),
    mockAnthropic(),
    mockOpenAi(),
    mockS3(),
    VitePWA({
      // A new version waits until src/lib/update.ts switches to it — automatically, but never in
      // the middle of a job that a reload would destroy.
      registerType: 'prompt',
      includeAssets: ['favicon-48x48.png', 'logo.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Закладка — читалка з AI',
        short_name: 'Закладка',
        description: 'Читалка EPUB, PDF і DjVu з AI-агентами, нотатками та малюванням. Працює офлайн.',
        lang: 'uk',
        display: 'standalone',
        start_url: './',
        scope: './',
        theme_color: '#2b3a55',
        background_color: '#f6f3ec',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        file_handlers: [
          {
            action: './',
            accept: {
              'application/pdf': ['.pdf'],
              'application/epub+zip': ['.epub'],
              'image/vnd.djvu': ['.djvu', '.djv'],
            },
          },
        ],
      },
      workbox: {
        // .wasm: the DjVu decoder, so DjVu books open offline too.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,wasm}'],
        globIgnores: ['pdfjs/**', 'tesseract/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        runtimeCaching: [
          {
            // The library that runs a language model in the browser; the model weights it keeps itself.
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/(@mlc-ai\/web-llm|@wllama\/wllama)/,
            handler: 'CacheFirst',
            options: { cacheName: 'browser-llm', expiration: { maxEntries: 6 }, cacheableResponse: { statuses: [0, 200] } },
          },
          {
            // PDF.js character maps and fallback fonts: fetched on demand, then kept for offline use.
            urlPattern: /\/pdfjs\/(cmaps|standard_fonts)\//,
            handler: 'CacheFirst',
            options: { cacheName: 'pdfjs-assets', expiration: { maxEntries: 300 } },
          },
          {
            // OCR engine (several MB): fetched the first time text is recognised, then available offline.
            urlPattern: /\/tesseract\//,
            handler: 'CacheFirst',
            options: { cacheName: 'ocr-engine', expiration: { maxEntries: 8 } },
          },
          {
            // Runtime of the in-browser embedding model; the model weights are cached by transformers.js itself.
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/(@huggingface\/transformers|onnxruntime-web)/,
            handler: 'CacheFirst',
            options: { cacheName: 'embedding-runtime', expiration: { maxEntries: 12 }, cacheableResponse: { statuses: [0, 200] } },
          },
        ],
      },
    }),
  ],
});
