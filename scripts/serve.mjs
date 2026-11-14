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
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ---- Looking things up on the web on behalf of the reader ----
// A page in a browser may not query a search engine or read another site (CORS); this server may.
// Used by the agents' web_search and read_web_page tools. Only public addresses are fetched, so the
// server cannot be used to reach into the home network or the computer itself.
// The requests are automatic and say so: a site or a search engine that does not serve automatic
// clients refuses, and the app then falls back to Wikipedia. Nothing here pretends to be a person.
const LOOKUP_UA = 'Mozilla/5.0 (compatible; ebook-reader-lookup/1.0)';

// Recent answers are kept for a while and requests to the search engine are spaced out, so that a
// chatty agent does not hammer it.
const searchCache = new Map();
const SEARCH_KEEP_MS = 15 * 60_000;
const SEARCH_GAP_MS = 2500;
let searchQueue = Promise.resolve();
let lastSearchAt = 0;
let refusedUntil = 0;

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:');
}

/** Fetches a public web page, following redirects by hand so that every hop is checked. */
async function fetchPublic(address, hops = 4) {
  const target = new URL(address);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Only http and https addresses can be opened.');
  const resolved = await dns.lookup(target.hostname, { all: true });
  if (!resolved.length || resolved.some((r) => isPrivateAddress(r.address))) throw new Error('This address is not on the public internet.');
  const answer = await fetch(target, {
    redirect: 'manual',
    headers: { 'User-Agent': LOOKUP_UA, 'Accept-Language': 'uk,en;q=0.8', Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' },
    signal: AbortSignal.timeout(12000),
  });
  if (answer.status >= 300 && answer.status < 400 && answer.headers.get('location')) {
    if (hops <= 0) throw new Error('Too many redirects.');
    return fetchPublic(new URL(answer.headers.get('location'), target).href, hops - 1);
  }
  return answer;
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (text) =>
  text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => entities[name.toLowerCase()] ?? m);
const plain = (html) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Search results from DuckDuckGo's plain HTML page: no key, no script. */
async function webSearch(query, lang) {
  const key = `${lang}|${query.toLowerCase()}`;
  const kept = searchCache.get(key);
  if (kept && Date.now() - kept.at < SEARCH_KEEP_MS) return kept.results;
  // After a refusal the engine is left alone for a while instead of being asked again and again.
  if (Date.now() < refusedUntil) throw new Error('The search engine is not serving automatic requests right now.');
  const turn = searchQueue.then(async () => {
    const wait = lastSearchAt + SEARCH_GAP_MS - Date.now();
    if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    lastSearchAt = Date.now();
    return askSearchEngine(query, lang);
  });
  searchQueue = turn.catch(() => {});
  const results = await turn;
  if (searchCache.size > 200) searchCache.clear();
  searchCache.set(key, { at: Date.now(), results });
  return results;
}

async function askSearchEngine(query, lang) {
  const region = { uk: 'ua-uk', en: 'us-en', pl: 'pl-pl', de: 'de-de' }[lang] ?? 'wt-wt';
  const answer = await fetchPublic(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${region}`);
  if (!answer.ok) throw new Error(`The search engine answered ${answer.status}.`);
  const html = await answer.text();
  const results = [];
  const block = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/g;
  for (let m; (m = block.exec(html)) && results.length < 8; ) {
    let link = decodeEntities(m[1]);
    // Results are wrapped in a redirect that carries the real address.
    const wrapped = /[?&]uddg=([^&]+)/.exec(link);
    if (wrapped) link = decodeURIComponent(wrapped[1]);
    if (link.startsWith('//')) link = `https:${link}`;
    if (!/^https?:/.test(link) || /duckduckgo\.com\/y\.js/.test(link)) continue;
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(m[3]);
    results.push({ title: plain(m[2]), url: link, snippet: snippet ? plain(snippet[1]) : '' });
  }
  if (!results.length && (answer.status === 202 || /anomaly|captcha|challenge/i.test(html))) {
    refusedUntil = Date.now() + 10 * 60_000;
    throw new Error('The search engine is not serving automatic requests right now.');
  }
  return results;
}

/** The readable text of a web page: scripts, styles and markup removed. */
async function webRead(address) {
  const answer = await fetchPublic(address);
  if (!answer.ok) throw new Error(`The site answered ${answer.status}.`);
  const type = answer.headers.get('content-type') ?? '';
  if (!/text\/|xhtml|xml/.test(type)) throw new Error(`This is not a text page (${type || 'unknown type'}).`);
  const html = (await answer.text()).slice(0, 3_000_000);
  const title = plain(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  const body = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = decodeEntities(
    body
      .replace(/<(script|style|noscript|svg|nav|header|footer|form|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|br|section)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return { title, text: text.slice(0, 60_000) };
}

async function handleWeb(url, res) {
  const send = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
  try {
    if (url.pathname === '/web' || url.pathname === '/web/') return send(200, { search: true, read: true });
    if (url.pathname === '/web/search') {
      const query = (url.searchParams.get('q') ?? '').trim();
      if (!query) return send(400, { error: 'Nothing to search for.' });
      return send(200, { results: await webSearch(query, url.searchParams.get('lang') ?? '') });
    }
    if (url.pathname === '/web/read') return send(200, await webRead(url.searchParams.get('url') ?? ''));
    return send(404, { error: 'Unknown request.' });
  } catch (err) {
    return send(502, { error: err instanceof Error ? err.message : String(err) });
  }
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
