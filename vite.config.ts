import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * What this build is called, for showing to the reader. The first two numbers of the version are
 * those of package.json; the third is the number of commits the build was made from, so it grows by
 * itself with every change and nobody has to remember to raise it. A "+" at the end marks a build
 * made from files that are not committed yet. Outside a git checkout (or with a shallow one, which
 * cannot count its commits) the version of package.json is used as it stands.
 */
function buildInfo(): { version: string; commit: string } {
  const declared = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '0.0.0');
  const git = (args: string) => {
    try {
      return execSync(`git ${args}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return '';
    }
  };
  const commit = git('rev-parse --short HEAD');
  const commits = git('rev-parse --is-shallow-repository') === 'false' ? Number(git('rev-list --count HEAD')) || 0 : 0;
  if (!commit || !commits) return { version: declared, commit };
  const [major = '0', minor = '0'] = declared.split('.');
  // While Vite reads this file it keeps a compiled copy beside it (vite.config.ts.timestamp-….mjs),
  // which git reports as a new file; counting it would mark every build as changed.
  const changed = git('status --porcelain')
    .split('\n')
    .some((line) => line.trim() !== '' && !/vite\.config\.\w+\.timestamp-/.test(line));
  return { version: `${major}.${minor}.${commits}${changed ? '+' : ''}`, commit };
}

/** Dev only: the web lookups of scripts/serve.mjs (search, page text, whole pages and pictures for saved articles). */
function webLookups(): Plugin {
  return {
    name: 'web-lookups',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/web', (req, res) => {
        void import(pathToFileURL(path.join(root, 'scripts', 'web.mjs')).href).then((m) =>
          m.handleWeb(new URL(req.originalUrl ?? req.url ?? '/', 'http://localhost'), res),
        );
      });
    },
  };
}

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
 * Dev only: what the mock model servers answer to the requests of lib/repo-book.ts, so that a book can
 * be made from a repository without a real model. The plan comes wrapped in prose and a code fence, and
 * every chapter carries one diagram that does not parse — both on purpose: that is how small models
 * answer, and the app has to cope. Returns null for any other request.
 */
function mockBookAnswer(system: string, user: string): string | null {
  const uk = /Write in Ukrainian|in Ukrainian;/.test(system);
  if (system.startsWith('You plan')) {
    const repoFiles = [...user.matchAll(/^(\S.*?) · [\d.]+ (?:B|KB)$/gm)].map((m) => m[1]);
    const changed = [...user.matchAll(/^(\S+) · \w+ · \+\d+ −\d+$/gm)].map((m) => m[1]);
    const files = changed.length ? changed : repoFiles;
    const count = Math.max(2, Math.min(Number(/(?:Exactly|At most) (\d+) chapters/.exec(system)?.[1] ?? 4), files.length));
    const chapters = Array.from({ length: count }, (_, i) => ({
      title: uk ? `Частина ${i + 1}: ${files[i % files.length].split('/').pop()}` : `Part ${i + 1}: ${files[i % files.length].split('/').pop()}`,
      brief: uk ? 'Що робить ця частина і як вона повʼязана з рештою; діаграма показує потік даних.' : 'What this part does and how it connects to the rest; the diagram shows the data flow.',
      // One path is given without its folders and one does not exist: the app has to sort that out.
      files: [files[i % files.length], files[(i + 1) % files.length].split('/').pop(), 'no/such/file.ts'],
    }));
    const plan = { title: uk ? 'Як це влаштовано' : 'How it is built', subtitle: uk ? 'Пробна книжка від імітації моделі' : 'A trial book from the mock model', chapters };
    return 'Here is the plan:\n```json\n' + JSON.stringify(plan, null, 2) + '\n```';
  }
  if (system.startsWith('You repair Mermaid')) return 'flowchart TD\n  A["Вхід"] --> B["Обробка"]\n  B --> C["Вихід"]';
  if (system.startsWith('You write ')) {
    const title = /Write (?:chapter|article) \d+: "(.+?)"/.exec(user)?.[1] ?? '';
    const path = /<(?:file|change) path="([^"]+)"/.exec(user)?.[1] ?? 'README.md';
    const diff = /<change path=/.test(user);
    return [
      // An article is asked for a headline of its own on the first line.
      ...(/headline of your own/.test(system) ? [uk ? `# Пробна стаття: ${path}` : `# A trial article: ${path}`] : []),
      uk ? `Це пробний текст розділу «${title}». Він написаний імітацією моделі, щоб перевірити, як застосунок складає книжку: абзаци, **виділення**, код у рядку на кшталт \`${path}\`, діаграми й таблиці.` : `This is a trial text of the chapter "${title}", written by the mock model to check how the app puts a book together: paragraphs, **emphasis**, inline code like \`${path}\`, diagrams and tables.`,
      uk ? '## Як це працює' : '## How it works',
      uk ? 'Запит проходить кілька кроків: спершу його приймає вхідна точка, далі дані перевіряються, і лише потім зберігаються. Стрілки → показують напрямок.' : 'A request passes several steps: the entry point takes it, the data is checked, and only then stored.',
      '```mermaid\nflowchart TD\n  A["Запит"] --> B["Перевірка"]\n  B -->|"гаразд"| C["Збереження"]\n  B -->|"помилка"| D["Відмова"]\n```',
      uk ? '*Шлях запиту від входу до збереження.*' : '*The path of a request from entry to storage.*',
      diff ? '```diff\n@@ -1,3 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = a + b;\n```' : '```ts\nexport function example(input: string): number {\n  // Довгий рядок, щоб перевірити перенесення коду на вузькому екрані та в PDF: він має лишитися читабельним, а не вилізти за край сторінки.\n  return input.length;\n}\n```',
      uk ? '## Що з чим повʼязано' : '## What connects to what',
      '| ' + (uk ? 'Частина | Роль' : 'Part | Role') + ' |\n| --- | --- |\n| \`' + path + '\` | ' + (uk ? 'головний файл розділу' : 'the main file of the chapter') + ' |\n| API | ' + (uk ? 'приймає запити' : 'takes requests') + ' |',
      // A diagram with a mistake in it: the app sends it back to be repaired.
      '```mermaid\nflowchart TD\n  A[Вхід (сирий)] --> --> B\n```',
      uk ? '*Спрощена схема після виправлення.*' : '*The simplified scheme after the repair.*',
      uk ? '> **Варто знати.** Це врізка: число, факт або порада.' : '> **Worth knowing.** This is a sidebar: a number, a fact or a tip.',
      uk ? '## Головне' : '## Key points',
      uk ? '- перший висновок\n- другий висновок\n- третій висновок ✓' : '- the first point\n- the second point\n- the third point ✓',
    ].join('\n\n');
  }
  return null;
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

          const systemText = typeof body.system === 'string' ? body.system : (body.system ?? []).map((p: { text?: string }) => p.text ?? '').join('');
          const bookText = body.tools ? null : mockBookAnswer(systemText, blocks.find((b) => b.type === 'text')?.text ?? empty);
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

          if (bookText !== null) {
            await send('content_block_start', { index: 1, content_block: { type: 'text', text: empty } });
            for (let i = 0; i < bookText.length; i += 400) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: bookText.slice(i, i + 400) } })}\n\n`);
            await send('content_block_stop', { index: 1 });
            await send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } });
          } else if (toolResult) {
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
          const bookText = body.tools ? null : mockBookAnswer(textOf(messages.find((m) => m.role === 'system')), textOf(last));
          if (bookText !== null) {
            await send({ role: 'assistant', content: '<think>mock reasoning</think>' });
            for (let i = 0; i < bookText.length; i += 400) res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: bookText.slice(i, i + 400) }, finish_reason: null }] })}\n\n`);
            await send({}, 'stop');
            res.write('data: [DONE]\n\n');
            return void res.end();
          }
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

const build = buildInfo();

export default defineConfig({
  // Which build this is and when it was made: shown in the library and in the settings, so a reader
  // can tell which version a device runs (see src/lib/version.ts).
  define: {
    __APP_VERSION__: JSON.stringify(build.version),
    __BUILD_COMMIT__: JSON.stringify(build.commit),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
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
    webLookups(),
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
        share_target: { action: './', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } },
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
            // Fonts for the PDFs the app writes: fetched when the first one is made, then available offline.
            urlPattern: /\/assets\/DejaVu[^/]+\.ttf$/,
            handler: 'CacheFirst',
            options: { cacheName: 'pdf-fonts', expiration: { maxEntries: 8 } },
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
