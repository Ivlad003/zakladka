// Looking things up on the web for the reader: search, page text, whole pages and pictures for
// saving articles. Used by scripts/serve.mjs and by the dev server (vite.config.ts).
import dns from 'node:dns/promises';
import net from 'node:net';

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
async function fetchPublic(address, hops = 4, accept = 'text/html,application/xhtml+xml,text/plain;q=0.9') {
  const target = new URL(address);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Only http and https addresses can be opened.');
  const resolved = await dns.lookup(target.hostname, { all: true });
  if (!resolved.length || resolved.some((r) => isPrivateAddress(r.address))) throw new Error('This address is not on the public internet.');
  const answer = await fetch(target, {
    redirect: 'manual',
    headers: { 'User-Agent': LOOKUP_UA, 'Accept-Language': 'uk,en;q=0.8', Accept: accept },
    signal: AbortSignal.timeout(12000),
  });
  if (answer.status >= 300 && answer.status < 400 && answer.headers.get('location')) {
    if (hops <= 0) throw new Error('Too many redirects.');
    return fetchPublic(new URL(answer.headers.get('location'), target).href, hops - 1, accept);
  }
  // Where the page really is, after redirects: relative links and pictures are resolved against it.
  return Object.assign(answer, { finalUrl: target.href });
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

export async function handleWeb(url, res) {
  const send = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
  try {
    if (url.pathname === '/web' || url.pathname === '/web/') return send(200, { search: true, read: true, page: true });
    if (url.pathname === '/web/page') return send(200, await webPage(url.searchParams.get('url') ?? ''));
    if (url.pathname === '/web/fetch') return void (await webPicture(url.searchParams.get('url') ?? '', res));
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


/** A whole web page, for saving an article to read later (the app picks the article out of it). */
async function webPage(address) {
  const answer = await fetchPublic(address);
  if (!answer.ok) throw new Error(`The site answered ${answer.status}.`);
  const type = answer.headers.get('content-type') ?? '';
  if (!/html|xml/.test(type)) throw new Error(`This is not a web page (${type || 'unknown type'}).`);
  return { url: answer.finalUrl, html: (await answer.text()).slice(0, 4_000_000) };
}

/** A picture from a saved article, so that it can be kept with the article for reading offline. */
async function webPicture(address, res) {
  const answer = await fetchPublic(address, 4, 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8');
  const type = answer.headers.get('content-type') ?? '';
  if (!answer.ok || !type.startsWith('image/')) throw new Error(`Not a picture (${answer.status} ${type}).`);
  const data = Buffer.from(await answer.arrayBuffer());
  if (data.length > 8_000_000) throw new Error('The picture is too large.');
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' }).end(data);
}
