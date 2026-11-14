// Looking things up outside the book, for the agents' `web_search` and `read_web_page` tools.
//
// A browser may only call services that allow it (CORS), which rules out search engines and most
// sites. So there are three ways, picked in the AI settings:
//   • the app's own server (scripts/serve.mjs), when the app is opened through it: the server asks a
//     search engine and reads pages on the reader's behalf — a real web search, with no key;
//   • Wikipedia, whose API is open to browsers: always available, and covers what a reader most
//     often wants explained — people, terms, events, places;
//   • a SearXNG instance of the reader's own, reached directly or through the app's proxy.
import { trimUrl } from '../ai/providers';
import { getSettings } from '../settings';
import { timeoutSignal } from './utils';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

interface WikiPage {
  title: string;
  index?: number;
  extract?: string;
  fullurl?: string;
}

async function wikipedia(query: string, lang: string): Promise<WebResult[]> {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: '5',
    prop: 'extracts|info',
    inprop: 'url',
    exintro: '1',
    explaintext: '1',
    exchars: '900',
    format: 'json',
    origin: '*',
  });
  const res = await fetch(`https://${lang}.wikipedia.org/w/api.php?${params}`, { signal: timeoutSignal(12000) });
  if (!res.ok) throw new Error(`Wikipedia answered ${res.status}.`);
  const json = (await res.json()) as { query?: { pages?: Record<string, WikiPage> } };
  return Object.values(json.query?.pages ?? {})
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => ({ title: p.title, url: p.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`, snippet: (p.extract ?? '').trim() }));
}

async function wikipediaWithFallback(query: string, lang: string): Promise<WebResult[]> {
  const results = await wikipedia(query, lang);
  // A small Wikipedia often has nothing where the English one has an article.
  return results.length < 2 && lang !== 'en' ? [...results, ...(await wikipedia(query, 'en'))] : results;
}

async function searxng(base: string, query: string, lang: string): Promise<WebResult[]> {
  const params = new URLSearchParams({ q: query, format: 'json', language: lang });
  const res = await fetch(`${trimUrl(base)}/search?${params}`, { signal: timeoutSignal(15000) });
  if (!res.ok) throw new Error(`The search service answered ${res.status}. It must allow the JSON format (search.formats in its settings).`);
  const json = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (json.results ?? []).slice(0, 8).map((r) => ({ title: r.title ?? r.url ?? '', url: r.url ?? '', snippet: (r.content ?? '').trim() }));
}

// ---- The app's own server ----
let serverOffers: Promise<boolean> | null = null;

/** Whether the app is served by its own server, which can search the web and read pages for it. */
export function appServerSearches(): Promise<boolean> {
  return (serverOffers ??= fetch('/web/', { signal: timeoutSignal(4000) })
    .then(async (res) => res.ok && (res.headers.get('content-type') ?? '').includes('json') && Boolean(((await res.json()) as { search?: boolean }).search))
    .catch(() => false));
}

async function viaServer<T>(path: string): Promise<T> {
  const res = await fetch(path, { signal: timeoutSignal(20000) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `The app's server answered ${res.status}.`);
  return json;
}

/** Searches with whatever the reader has chosen in the settings. `lang` is a two-letter code. */
export async function webSearch(query: string, lang: string): Promise<{ source: string; results: WebResult[] }> {
  const s = getSettings();
  if (s.webSearch === 'off') throw new Error('Web search is switched off in the AI settings.');
  if (s.webSearch === 'searxng') {
    if (!trimUrl(s.searxngUrl)) throw new Error('No address of a SearXNG instance is set in the AI settings.');
    return { source: 'SearXNG', results: await searxng(s.searxngUrl, query, lang) };
  }
  if (s.webSearch === 'auto' && (await appServerSearches())) {
    try {
      const { results } = await viaServer<{ results: WebResult[] }>(`/web/search?${new URLSearchParams({ q: query, lang })}`);
      if (results.length) return { source: 'Web search', results };
    } catch {
      // The search engine refused or is unreachable: Wikipedia still answers.
    }
  }
  return { source: 'Wikipedia', results: await wikipediaWithFallback(query, lang) };
}

async function readWikipediaArticle(url: string, limit: number): Promise<{ title: string; text: string } | null> {
  const m = /^https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i.exec(url.trim());
  if (!m) return null;
  const params = new URLSearchParams({ action: 'query', prop: 'extracts', explaintext: '1', redirects: '1', titles: decodeURIComponent(m[2]).replace(/_/g, ' '), format: 'json', origin: '*' });
  const res = await fetch(`https://${m[1]}.wikipedia.org/w/api.php?${params}`, { signal: timeoutSignal(12000) });
  if (!res.ok) throw new Error(`Wikipedia answered ${res.status}.`);
  const json = (await res.json()) as { query?: { pages?: Record<string, WikiPage> } };
  const page = Object.values(json.query?.pages ?? {})[0];
  return page?.extract ? { title: page.title, text: page.extract.slice(0, limit) } : null;
}

/**
 * The text of a web page. Wikipedia articles are read straight from its API; anything else needs
 * the app's own server, since a browser cannot read another site.
 */
export async function readWebPage(url: string, limit: number): Promise<{ title: string; text: string }> {
  if (getSettings().webSearch === 'off') throw new Error('Web access is switched off in the AI settings.');
  const article = await readWikipediaArticle(url, limit);
  if (article) return article;
  if (!(await appServerSearches())) throw new Error('Only Wikipedia articles can be opened here: reading other sites needs the app to be opened through its own server (npm run serve).');
  const page = await viaServer<{ title: string; text: string }>(`/web/read?${new URLSearchParams({ url })}`);
  return { title: page.title, text: page.text.slice(0, limit) };
}
