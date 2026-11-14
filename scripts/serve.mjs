// Serves the built reader (dist/) and, on the same address, forwards /proxy/<name>/… to model
// servers running on this computer (Ollama, LM Studio, …).
//
// Why the proxy: a phone or tablet cannot reach "localhost" of the PC, and an app opened over
// HTTPS may not call plain-HTTP addresses at all. With the proxy the models live at the same
// address as the reader itself — /proxy/ollama/v1 — whatever that address is.
//
//   node scripts/serve.mjs                 only this computer (put Tailscale Serve or another HTTPS proxy in front)
//   node scripts/serve.mjs --lan           also reachable from the home network by http://<ip>:8787
//   node scripts/serve.mjs --port 9000 --proxy llama=http://127.0.0.1:8080
//
// No dependencies; needs Node 18 or newer.
import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleWeb } from './web.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// ---- Options ----
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(option('port') ?? process.env.PORT ?? 8787);
const host = option('host') ?? (args.includes('--lan') ? '0.0.0.0' : '127.0.0.1');

/**
 * LM Studio lets its server run on any port and records the choice in its settings folder.
 * Read on every request, so changing the port in LM Studio needs no restart here.
 */
function lmStudioUrl() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.lmstudio', '.internal', 'http-server-config.json'), 'utf8'));
    if (Number.isInteger(config.port)) return `http://127.0.0.1:${config.port}`;
  } catch {
    // Not installed, or a version that keeps its settings elsewhere: fall back to the standard port.
  }
  return 'http://127.0.0.1:1234';
}

/** Name → address of the server, or a function that finds it. */
const proxies = new Map([
  ['ollama', 'http://127.0.0.1:11434'],
  ['lmstudio', lmStudioUrl],
]);
const resolve = (target) => (typeof target === 'function' ? target() : target);
const extra = [...(process.env.ZAKLADKA_PROXY ?? '').split(','), ...args.flatMap((a, i) => (a === '--proxy' ? [args[i + 1] ?? ''] : []))];
for (const pair of extra) {
  const m = /^([a-z0-9_-]+)=(https?:\/\/.+)$/i.exec(pair.trim());
  if (m) proxies.set(m[1].toLowerCase(), m[2].replace(/\/+$/, ''));
  else if (pair.trim()) console.warn(`Пропускаю незрозумілий проксі «${pair}». Формат: назва=http://адреса:порт`);
}

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('Немає зібраного застосунку (dist/). Спершу виконайте: npm run build');
  process.exit(1);
}

// ---- Static files ----
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  if (pathname.endsWith('/')) file = path.join(file, 'index.html');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return void res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не знайдено');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      // File names under /assets carry a content hash; everything else must be revalidated so updates arrive.
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---- Proxy ----
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

function forward(req, res, name, rest) {
  if (!proxies.has(name)) return void res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `Невідомий проксі «${name}»` }));
  const base = resolve(proxies.get(name));
  const target = new URL(base + rest);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    // Origin and Referer are dropped on purpose: to the model server this is a local request,
    // so it needs no CORS setup (OLLAMA_ORIGINS and the like).
    if (!HOP_BY_HOP.has(key) && key !== 'origin' && key !== 'referer') headers[key] = value;
  }
  const upstream = http.request(target, { method: req.method, headers }, (answer) => {
    const out = {};
    for (const [key, value] of Object.entries(answer.headers)) {
      if (!HOP_BY_HOP.has(key) && !key.startsWith('access-control-')) out[key] = value;
    }
    res.writeHead(answer.statusCode ?? 502, out);
    // Streamed answers (tokens as they are generated) pass through chunk by chunk.
    answer.pipe(res);
  });
  upstream.on('error', (err) => {
    if (res.headersSent) return void res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: `Сервер «${name}» (${base}) не відповідає: ${err.message}` } }));
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/web' || url.pathname.startsWith('/web/'))) return void handleWeb(url, res);
  if (url.pathname === '/proxy' || url.pathname === '/proxy/') {
    // Lets the settings dialog offer the proxied servers as ready-made addresses.
    return void res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ proxies: [...proxies.keys()] }));
  }
  const m = /^\/proxy\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (m) return forward(req, res, m[1].toLowerCase(), (m[2] ?? '/') + url.search);
  if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
  serveStatic(req, res, url.pathname);
});

server.listen(port, host, () => {
  console.log(`Закладка: http://localhost:${port}`);
  if (host === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list ?? []) if (net.family === 'IPv4' && !net.internal) console.log(`           http://${net.address}:${port}`);
    }
    console.log('Увага: за цими адресами застосунок і сервери моделей доступні всім у вашій мережі.');
  }
  for (const [name, target] of proxies) console.log(`  /proxy/${name}  →  ${resolve(target)}`);
  tailscaleHint();
});

/** If this computer is on a Tailscale network, says how to reach the reader from the other devices on it. */
function tailscaleHint() {
  const run = (args) =>
    new Promise((done) => execFile('tailscale', args, { timeout: 4000, windowsHide: true }, (err, stdout) => done(err ? null : stdout)));
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  void (async () => {
    const status = parse(await run(['status', '--json']));
    const name = status?.Self?.DNSName?.replace(/\.$/, '');
    if (!name || status.BackendState !== 'Running') return;
    if (!status.CertDomains?.includes(name)) {
      console.log(`Tailscale: HTTPS для цієї мережі не ввімкнено. Без нього застосунок відкривається як звичайна сторінка: запустіть із --lan і заходьте на http://${name}:${port}`);
      return;
    }
    // Is Tailscale Serve already forwarding to this port?
    const serve = parse(await run(['serve', 'status', '--json']));
    const forwarded = JSON.stringify(serve?.Web ?? {}).includes(`:${port}"`);
    if (forwarded) console.log(`Tailscale: з інших ваших пристроїв — https://${name}`);
    else console.log(`Tailscale: щоб відкривати з телефона чи планшета, виконайте  tailscale serve --bg ${port}  — адреса буде https://${name}`);
  })();
}
