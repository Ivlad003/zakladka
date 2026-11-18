// A book made from a repository: the repository itself at a branch, a pull request, the difference
// between two branches, one commit. Three kinds — a book and a magazine issue, which a model writes
// from the files (a plan first, then chapter by chapter, each from the files the plan gave it, with
// diagrams drawn into pictures), and "the code as it is", put together without any model. The result
// is an EPUB on the shelf "Репозиторії", read like any other book.
import { complete, RefusedError } from '../ai/complete';
import { resolveProvider, type ChatProvider } from '../ai/providers';
import { db } from '../db';
import { buildEpub, escapeXml, type EpubToc } from '../engines/epub-build';
import { getSettings } from '../settings';
import type { BookMade } from '../types';
import { drawCover } from './book-cover';
import { BOOK_CSS, cleanText, codeHtml, diffHtml, MAGAZINE_CSS, markdownToXhtml, type PageContext } from './book-pages';
import { duringWork } from './busy';
import { diagramPicture } from './diagram';
import { getCommit, getCompare, getFileBytes, getFileText, getPull, getTree, type ChangeSet, type ChangedFile, type RepoInfo, type RepoTarget, type RepoTree, type TreeFile } from './github';
import { importBooks } from './library';
import { bookLang, bookWords, type BookWords } from './repo-book-words';
import { escapeRegExp, timeoutSignal } from './utils';

/** A book, a magazine issue and a single article are written by a model; "plain" is the code as it is. */
export type BookKind = 'book' | 'magazine' | 'article' | 'plain';
export type BookSize = 'short' | 'medium' | 'long';

export const REPO_SHELF = 'Репозиторії';

/**
 * How large a book of each size is: chapters and words per chapter for a written one, words of a
 * single article, characters of source for the code as it is, characters of diffs shown in full.
 */
export const BOOK_SIZES: Record<BookSize, { name: string; chapters: number; words: number; articleWords: number; plainChars: number; patchChars: number }> = {
  short: { name: 'Коротка', chapters: 4, words: 450, articleWords: 600, plainChars: 150_000, patchChars: 40_000 },
  medium: { name: 'Середня', chapters: 7, words: 700, articleWords: 1000, plainChars: 500_000, patchChars: 150_000 },
  long: { name: 'Докладна', chapters: 12, words: 1000, articleWords: 1600, plainChars: 1_500_000, patchChars: 500_000 },
};

/** Minutes a written book or article of this size takes to read; text with code in it reads slower than prose. */
export const readingMinutes = (kind: BookKind, size: BookSize): number =>
  kind === 'article' ? Math.round(BOOK_SIZES[size].articleWords / 180) : Math.round((BOOK_SIZES[size].chapters * BOOK_SIZES[size].words) / 180 / 5) * 5;

export interface BookRequest {
  repo: RepoInfo;
  target: RepoTarget;
  kind: BookKind;
  size: BookSize;
  /** Language of the book, an id from BOOK_LANGS. */
  lang: string;
}

export interface BookProgress {
  step: string;
  done: number;
  total: number;
}

interface OutlineChapter {
  title: string;
  brief: string;
  files: string[];
}

interface Outline {
  title: string;
  subtitle: string;
  chapters: OutlineChapter[];
}

/**
 * What has been written so far. It outlives a failed attempt, so that trying again after an error
 * (a dropped connection at chapter nine) continues instead of starting over.
 */
export interface BookDraft {
  key: string;
  outline: Outline | null;
  chapters: Map<number, string>;
}

export const newDraft = (): BookDraft => ({ key: '', outline: null, chapters: new Map() });

// ---- Which files of a repository are worth reading ----

const SKIP_DIRS = /(^|\/)(node_modules|bower_components|vendor|vendors|third_party|third-party|dist|\.git|\.next|\.nuxt|\.svelte-kit|\.cache|\.idea|\.vscode|__pycache__|\.venv|venv|coverage|\.gradle|Pods|DerivedData|\.dart_tool|\.yarn|\.pnpm-store|\.terraform)\//;
const SKIP_FILES =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|Gemfile\.lock|go\.sum|flake\.lock|packages\.lock\.json|\.DS_Store|Thumbs\.db)$|\.(min\.(js|css)|map|snap|lock)$|(^|\/)\.env(\.(?!example|sample|template|dist)[\w.-]+)?$/i;
const BINARY =
  /\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|psd|ai|sketch|fig|svg|mp[34]|m4a|wav|ogg|flac|mov|avi|mkv|webm|pdf|epub|mobi|djvu?|docx?|xlsx?|pptx?|odt|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|o|a|so|dll|dylib|exe|bin|dat|db|sqlite3?|wasm|woff2?|ttf|otf|eot|pyc|pyo|nupkg|keystore|jks|p12|pfx|der|crt|cer|pem|key|onnx|pt|pth|safetensors|gguf|npy|npz|parquet|h5|pkl)$/i;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' };
const DOC = /\.(md|mdx|markdown)$/i;
const MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'setup.py', 'requirements.txt', 'CMakeLists.txt', 'deno.json', 'pubspec.yaml', 'mix.exs', 'Makefile'];

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', cs: 'C#', rb: 'Ruby', php: 'PHP', css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML', vue: 'Vue', svelte: 'Svelte',
  sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', sql: 'SQL', dart: 'Dart', lua: 'Lua', scala: 'Scala', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hs: 'Haskell', clj: 'Clojure', r: 'R',
  m: 'Objective-C', mm: 'Objective-C', zig: 'Zig', nim: 'Nim', tf: 'Terraform', proto: 'Protobuf', graphql: 'GraphQL', sol: 'Solidity', jl: 'Julia', pl: 'Perl',
};

const extOf = (path: string) => /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
/** A path in the repository from where a document stands and what it refers to; "" when it leads outside. */
function joinPath(baseDir: string, relative: string): string {
  const stack: string[] = [];
  for (const part of (relative.startsWith('/') ? relative : [baseDir, relative].filter(Boolean).join('/')).split('/')) {
    if (part === '..') stack.pop();
    else if (part && part !== '.') stack.push(part);
  }
  return stack.join('/');
}
const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`);

/** The text files of the tree a book can be made of, within `folder`. */
function readable(files: TreeFile[], folder: string, maxSize: number): TreeFile[] {
  const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
  return files.filter((f) => f.path.startsWith(prefix) && f.size > 0 && f.size <= maxSize && !SKIP_DIRS.test(`${f.path}`) && !SKIP_FILES.test(f.path) && !BINARY.test(f.path));
}

/** How much a file is likely to tell about the project; the higher, the sooner it gets its place. */
function weight(file: TreeFile, folder: string): number {
  const path = folder ? file.path.slice(folder.length + 1) : file.path;
  const name = nameOf(path).toLowerCase();
  const depth = path.split('/').length - 1;
  let w = 30 - depth * 4;
  if (/^readme(\.|$)/.test(name)) w += depth ? 22 : 80;
  else if (DOC.test(name)) w += depth === 0 ? 26 : /(^|\/)docs?\//i.test(path) ? 20 : 6;
  if (MANIFESTS.some((m) => m.toLowerCase() === name)) w += depth === 0 ? 34 : 8;
  if (/^(main|index|app|server|cli|lib|mod|__init__|__main__|program|application)\.[a-z0-9]+$/.test(name)) w += 14;
  if (/(^|\/)(src|lib|app|core|pkg|cmd|internal|server|client|api)\//i.test(path)) w += 12;
  if (/(^|\/)(tests?|__tests__|spec|e2e|fixtures?|mocks?|examples?|samples?|demo|benchmarks?|scripts?|tools?|\.github|migrations?|locales?|i18n|assets|public|static)\//i.test(path) || /[._-](test|spec)\.[a-z]+$/.test(name)) w -= 18;
  if (name.startsWith('.')) w -= 15;
  if (/\.(json|ya?ml|toml|xml|csv|ini|cfg|conf|txt)$/.test(name)) w -= 8;
  if (LANGUAGES[extOf(name)]) w += 6;
  // A larger file usually carries more of the program — up to a point: very large ones are data or generated.
  w += Math.min(10, Math.log2(1 + file.size / 400));
  if (file.size > 150_000) w -= 20;
  return w;
}

function languageShares(files: TreeFile[]): string {
  const bytes = new Map<string, number>();
  for (const f of files) {
    const lang = LANGUAGES[extOf(f.path)];
    if (lang) bytes.set(lang, (bytes.get(lang) ?? 0) + f.size);
  }
  const total = [...bytes.values()].reduce((a, b) => a + b, 0);
  if (!total) return '';
  return [...bytes]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .filter(([, n]) => n / total >= 0.01)
    .map(([lang, n]) => `${lang} ${Math.round((n / total) * 100)}%`)
    .join(', ');
}

// ---- Words to and from the model ----

const DIAGRAM_RULES = (language: string) =>
  `use flowchart TD, sequenceDiagram, classDiagram or stateDiagram-v2; at most 10 nodes; node ids are plain Latin letters and digits; every label goes in double quotes, like A["label"] or A -->|"label"| B; no parentheses, quotes, semicolons or HTML inside a label; labels are a few words in ${language} (names from the code stay as they are)`;

function outlineSystem(req: BookRequest, count: number, change: ChangeSet | null): string {
  const magazine = req.kind === 'magazine';
  const thing = magazine ? 'an issue of a magazine' : 'a book';
  const language = bookLang(req.lang).english;
  const shape = '{"title": "...", "subtitle": "...", "chapters": [{"title": "...", "brief": "...", "files": ["path", "..."]}]}';
  if (change) {
    const subject = change.type === 'pull' ? 'a pull request' : change.type === 'commit' ? 'one commit' : 'the difference between two branches';
    return `You plan ${thing} that walks a developer through a set of code changes: ${subject}. You get its description, the commit messages and the list of changed files. Reply with one JSON object and nothing else — no Markdown fence, no comments:
${shape}
- At most ${count} chapters and at least 2; fewer when the change is small.
- "files": paths copied character for character from the list of changed files — the changes that chapter covers. Group related changes together; every changed file of substance belongs to exactly one chapter.
- "brief": one or two sentences — what the chapter explains and what its diagram should show.
- ${
      magazine
        ? 'Order: a lead story on the main change; shorter pieces on the rest; a closing piece on what it means for those who use and maintain the code. Headlines are lively, but say what the piece is about.'
        : 'Order: first what is being changed and why; then the changes by theme, the most important first; last, what to check when reviewing and testing, and what could go wrong.'
    }
- "title" is the title of the whole ${magazine ? 'issue' : 'book'}, "subtitle" one line under it.
- Write titles, subtitle and briefs in ${language}; file paths stay as they are.`;
  }
  return `You plan ${thing} that explains a software repository to a developer who has never seen it. You get a description of the repository: its file list, the start of its README, its manifest. Reply with one JSON object and nothing else — no Markdown fence, no comments:
${shape}
- Exactly ${count} chapters.
- "files": 2 to 6 paths copied character for character from the file list — the sources that chapter will be written from. Choose the files that carry the substance (entry points, core modules), not configs and tests, unless the chapter is about them. Together the chapters should cover the most important files; do not give the same file to more than two chapters.
- "brief": one or two sentences — what the chapter explains and what its diagram should show.
- ${
    magazine
      ? 'Order: a cover story about the most interesting thing in this project; then features on its main parts; an explainer of how one mechanism works step by step; a short closing piece (what to try, what is left open). Headlines are lively, but say what the piece is about.'
      : 'Order: first what the project is for and how it is put together as a whole; then its main parts one by one, the most important first; then how data and control flow through them; last, how to build, run, test and extend it.'
  }
- "title" is the title of the whole ${magazine ? 'issue' : 'book'}, "subtitle" one line under it.
- Write titles, subtitle and briefs in ${language}; file paths stay as they are.`;
}

function chapterSystem(req: BookRequest, change: ChangeSet | null): string {
  const single = req.kind === 'article';
  const magazine = req.kind === 'magazine' || single;
  const language = bookLang(req.lang).english;
  const size = BOOK_SIZES[req.size];
  const about = change
    ? `a set of changes to the software repository ${req.repo.fullName} (${change.type === 'pull' ? `pull request ${change.label}` : change.type === 'commit' ? `commit ${change.label}` : `the difference ${change.label}`})`
    : `the software repository ${req.repo.fullName}${req.repo.description ? ` (${req.repo.description})` : ''}`;
  const diagrams = req.size === 'short' ? 'one Mermaid diagram' : 'one or two Mermaid diagrams';
  return `You write ${single ? 'a feature article for a technical magazine' : magazine ? 'one article of a magazine issue' : 'one chapter of a book'} about ${about}. Your reader is a developer who wants to understand ${change ? 'these changes without reading the diff' : 'this code without opening it'}.

Write in ${language}. Code, identifiers, file paths and commands stay exactly as they are in the sources.

Rules:
- Format: Markdown. ${
    single
      ? 'The first line is a headline of your own, as a first-level heading ("# "): a few words that say what the article is about. Then the text, with 2 to 4 subheadings ("## ").'
      : `Do not write the title of the ${magazine ? 'article' : 'chapter'} — begin with the text itself. Use 2 to 4 subheadings ("## ").`
  }
- Length: about ${single ? size.articleWords : size.words} words.
- Write only what the sources below show. Where they do not show something the reader would ask about, say in one sentence that it is outside these ${change ? 'changes' : 'files'} — never guess. Name files by their path in backticks.
- ${
    change
      ? 'The sources are diffs. Show the hunks that matter in blocks fenced with three backticks and the word diff — at most 20 lines each, copied from the sources — and explain what each changes in behaviour, not line by line.'
      : 'Quote code sparingly: excerpts of at most 15 lines, copied from the sources, in fenced blocks marked with the language.'
  }
- Include ${diagrams}: a block fenced with three backticks and the word mermaid, placed where it helps most, and right after it one line of caption in italics. ${change ? 'A diagram here shows what changed: the flow before and after, or the parts touched and how they connect. ' : ''}The program that draws the diagram is strict: ${DIAGRAM_RULES(language)}.
- No emoji. No remarks about the task or about yourself.
- ${
    magazine
      ? 'Open with a lead of two or three sentences that states the most interesting point. Write like a feature in a technical magazine: concrete, lively, no filler. Once in the article add a sidebar — a Markdown blockquote that starts with a bold title — with a number, a fact or a tip.'
      : 'Explain the why before the how: what problem this part solves, then how it does it, step by step. End with a subheading for the key points and 3 to 5 bullet points under it.'
  }`;
}

const MEND_SYSTEM = (language: string) =>
  `You repair Mermaid diagrams. You get a diagram that failed to parse and the parser's error. Reply with the corrected Mermaid code only — no fence, no explanation. Keep its meaning and its labels. The parser is strict: ${DIAGRAM_RULES(language)}.`;

/** The first complete JSON object in a model's reply, whatever it wrapped it in. */
function firstObject(text: string): unknown {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '\\') i++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

/** A plan out of a model's reply: only chapters that name files which exist are kept. */
function readOutline(text: string, paths: string[], count: number): Outline | null {
  const raw = firstObject(text) as { title?: unknown; subtitle?: unknown; chapters?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.chapters)) return null;
  const exact = new Set(paths);
  const lower = new Map(paths.map((p) => [p.toLowerCase(), p]));
  const find = (given: unknown): string | null => {
    if (typeof given !== 'string') return null;
    const path = given.trim().replace(/^\.?\//, '');
    if (exact.has(path)) return path;
    const same = lower.get(path.toLowerCase());
    if (same) return same;
    // A path given without its beginning, when only one file ends that way.
    const ends = paths.filter((p) => p.endsWith(`/${path}`));
    return ends.length === 1 ? ends[0] : null;
  };
  const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const chapters: OutlineChapter[] = [];
  for (const c of raw.chapters as { title?: unknown; brief?: unknown; files?: unknown }[]) {
    const title = str(c?.title).replace(/^(\d+[.)]\s*|#+\s*)/, '');
    const files = [...new Set((Array.isArray(c?.files) ? c.files : []).map(find).filter((p): p is string => Boolean(p)))].slice(0, 8);
    if (title && files.length) chapters.push({ title: title.slice(0, 140), brief: str(c?.brief).slice(0, 500), files });
  }
  if (chapters.length < Math.min(2, count)) return null;
  return { title: str(raw.title).slice(0, 140), subtitle: str(raw.subtitle).slice(0, 220), chapters: chapters.slice(0, count) };
}

/**
 * A model's chapter with the wrapping some models add taken off. A headline the model put first is
 * taken off too and handed to `headline`: an article is asked for one, a chapter has its title already.
 */
function tidyChapter(text: string, title: string, headline?: (title: string) => void): string {
  let t = text.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(t);
  if (fenced && !/\n```/.test(fenced[1].replace(/```[\s\S]*?```/g, ''))) t = fenced[1].trim();
  // Small models write a diagram as a tag of their own making, and its caption inside the diagram.
  t = t.replace(/<mermaid>\s*\n([\s\S]*?)\n\s*<\/mermaid>/gi, (_, code: string) => `\n\`\`\`mermaid\n${code.trim()}\n\`\`\`\n`);
  t = t.replace(/(```mermaid\n)([\s\S]*?)(\n```)/g, (_, open: string, code: string, close: string) => {
    const caption = /^\s*caption:?\s+"?(.+?)"?\s*$/im.exec(code);
    return caption ? `${open}${code.replace(caption[0], '').replace(/\n{2,}/g, '\n').trim()}${close}\n\n*${caption[1]}*` : `${open}${code}${close}`;
  });
  const first = /^#{1,3}\s+(.+)\n/.exec(t);
  const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (first && (plain(first[1]) === plain(title) || /^#\s/.test(first[0]))) {
    // Emphasis marks and closing hashes go; underscores and a "#" inside ("index_test.ts", "PR #12") stay.
    if (/^#\s/.test(first[0])) headline?.(first[1].replace(/[*`]/g, '').replace(/\s+#+\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 140));
    t = t.slice(first[0].length).trim();
  }
  return t;
}

/** Runs `job` for 0…count-1, at most `width` at a time; the first failure stops the rest. */
async function inParallel(count: number, width: number, job: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < count && !failed) {
      const i = next++;
      try {
        await job(i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, count)) }, worker));
}

// ---- Putting the book together ----

export function makeRepoBook(req: BookRequest, draft: BookDraft, onProgress: (p: BookProgress) => void, signal: AbortSignal): Promise<string> {
  // A book half-written must not be lost to the app updating itself.
  return duringWork(make(req, draft, onProgress, signal));
}

async function make(req: BookRequest, draft: BookDraft, onProgress: (p: BookProgress) => void, signal: AbortSignal): Promise<string> {
  const { repo, target } = req;
  const words = bookWords(req.lang);
  const language = bookLang(req.lang).english;
  const size = BOOK_SIZES[req.size];
  let provider: ChatProvider | null = null;
  if (req.kind !== 'plain') {
    const resolved = resolveProvider(getSettings());
    if (!('provider' in resolved)) throw new Error(resolved.missing);
    provider = resolved.provider;
  }
  const key = JSON.stringify([repo.fullName, target, req.kind, req.size, req.lang, provider?.name ?? '']);
  if (draft.key !== key) {
    draft.key = key;
    draft.outline = null;
    draft.chapters.clear();
  }
  // How much source text one request to the model may carry.
  const budget = provider ? Math.max(6_000, provider.readLimit * 2) : 0;
  /** A magazine issue and a single article share a look: a lead under the headline, sidebars. */
  const magazineLook = req.kind === 'magazine' || req.kind === 'article';
  const stopped = () => {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  };

  let done = 0;
  let total = 3;
  const say = (step: string) => onProgress({ step, done, total });

  // ---- 1. What there is to read ----
  say(target.type === 'repo' ? 'Читаю список файлів репозиторію…' : 'Завантажую зміни…');
  let tree: RepoTree | null = null;
  let change: ChangeSet | null = null;
  if (target.type === 'repo') tree = await getTree(repo, target.ref, signal);
  else if (target.type === 'pull') change = await getPull(repo, target.number, signal);
  else if (target.type === 'compare') change = await getCompare(repo, target.base, target.head, signal);
  else change = await getCommit(repo, target.sha, signal);
  const ref = target.type === 'repo' ? target.ref : '';
  const folder = target.type === 'repo' ? target.path.replace(/^\/+|\/+$/g, '') : '';
  const sources = tree ? readable(tree.files, folder, req.kind === 'plain' ? 150_000 : 400_000) : [];
  if (tree && !sources.length) throw new Error(folder ? `У теці «${folder}» немає текстових файлів, з яких можна скласти книжку.` : 'У цьому репозиторії немає текстових файлів, з яких можна скласти книжку.');
  if (change && !change.files.length) throw new Error('Тут немає змін: порівнювані гілки однакові.');
  const treePaths = new Set(tree?.files.map((f) => f.path) ?? []);
  const what = tree
    ? `${ref}${folder ? ` · ${folder}/` : ''}`
    : change!.type === 'commit'
      ? `${words.commitWord} ${change!.label}`
      : change!.label;
  const sourceUrl = tree ? `${repo.url}/tree/${tree.commit}${folder ? `/${folder}` : ''}` : change!.url;
  const plainTitle = change ? change.title || `${words.comparison}: ${change.label}` : folder ? `${repo.name}/${folder}` : repo.name;
  // Where the book comes from stands on the title page anyway; under the title goes what the project is.
  const plainSubtitle = repo.description;
  done = 1;

  // ---- Pictures and pages collected on the way ----
  const images: { file: string; type: string; data: Uint8Array }[] = [];
  const pages: { name: string; title: string; body: string }[] = [];
  const toc: EpubToc[] = [];
  let pictureCount = 0;
  let mends = 0;
  const texts = new Map<string, Promise<string | null>>();
  const readText = (path: string): Promise<string | null> => {
    let text = texts.get(path);
    if (!text) {
      text = getFileText(repo, tree!.commit, path, signal).then((t) => (t === null ? null : cleanText(t)));
      texts.set(path, text);
    }
    return text;
  };

  const drawDiagram = async (code: string, mend: boolean): Promise<{ file: string; width: number } | null> => {
    let source = code.trim();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const picture = await diagramPicture(source);
        const file = `images/d${String(images.length + 1).padStart(3, '0')}.${picture.type === 'image/png' ? 'png' : 'svg'}`;
        images.push({ file, type: picture.type, data: picture.data });
        return { file, width: picture.width };
      } catch (err) {
        // A diagram a model wrote wrongly is sent back to it once, with what the parser said.
        if (attempt || !mend || !provider || mends >= 8 || signal.aborted) return null;
        mends++;
        try {
          const fixed = await complete(provider, { system: MEND_SYSTEM(language), user: `Error: ${err instanceof Error ? err.message.slice(0, 600) : String(err)}\n\nDiagram:\n${source}`, signal });
          source = fixed.text.replace(/^```(?:mermaid)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
        } catch {
          return null;
        }
      }
    }
    return null;
  };

  const pictures = new Map<string, Promise<string | null>>();
  /** A picture a README or a description shows, brought into the book. */
  const loadPicture = (src: string, baseDir: string): Promise<string | null> => {
    const fetchIt = async (): Promise<string | null> => {
      if (/^data:/i.test(src) || pictureCount >= 30) return null;
      // Badges (build status, version) say nothing in a book and go stale.
      if (/shields\.io|badgen\.net|badge|travis-ci|circleci|codecov\.io|coveralls|\/workflows\/|deepscan|snyk\.io|img\.shields/i.test(src)) return null;
      let data: Uint8Array | null = null;
      let type = '';
      let path: string | null = null;
      const own = new RegExp(`^https?://(?:github\\.com|raw\\.githubusercontent\\.com)/${escapeRegExp(repo.owner)}/${escapeRegExp(repo.name)}/(?:(?:raw|blob)/)?(.+?)(?:[?#].*)?$`, 'i').exec(src);
      if (own && tree) {
        // "<branch>/<path>": the branch may have slashes of its own, so the path is whatever ending of it is a file.
        const parts = decodeURIComponent(own[1]).split('/');
        for (let i = 1; i < parts.length && !path; i++) if (treePaths.has(parts.slice(i).join('/'))) path = parts.slice(i).join('/');
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//') && tree) {
        const there = joinPath(baseDir, decodeURIComponent(src.replace(/[?#].*$/, '')));
        if (treePaths.has(there)) path = there;
      }
      try {
        if (path) {
          type = IMAGE_TYPES[extOf(path)] ?? '';
          if (!type) return null;
          data = await getFileBytes(repo, tree!.commit, path, signal);
        } else if (/^https?:/i.test(src)) {
          // Another site: straight from it where it allows that, else through the app's own server.
          let res = await fetch(src, { signal: timeoutSignal(15000) }).catch(() => null);
          if (!res?.ok) res = await fetch(`/web/fetch?${new URLSearchParams({ url: src })}`, { signal: timeoutSignal(15000) }).catch(() => null);
          type = (res?.headers.get('content-type') ?? '').split(';')[0].trim();
          if (!res?.ok || !Object.values(IMAGE_TYPES).includes(type)) return null;
          data = new Uint8Array(await res.arrayBuffer());
        }
      } catch {
        return null;
      }
      if (!data || !data.length || data.length > 4_000_000 || pictureCount >= 30) return null;
      const ext = Object.entries(IMAGE_TYPES).find(([, t]) => t === type)?.[0] ?? 'img';
      const file = `images/p${String(++pictureCount).padStart(3, '0')}.${ext}`;
      images.push({ file, type, data });
      return file;
    };
    const id = `${baseDir}\n${src}`;
    let picture = pictures.get(id);
    if (!picture) pictures.set(id, (picture = fetchIt()));
    return picture;
  };

  /** How Markdown that came from the repository (a README, a description) becomes a page. */
  const fromRepo = (baseDir: string): PageContext => ({
    diagramAlt: words.diagram,
    drawDiagram: (code) => drawDiagram(code, false),
    loadImage: (src) => loadPicture(src, baseDir),
    resolveLink(href) {
      if (/^(https?:|mailto:)/i.test(href)) return href;
      if (href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) || !tree) return null;
      const path = joinPath(baseDir, href.replace(/[?#].*$/, ''));
      return path ? `${repo.url}/${treePaths.has(path) ? 'blob' : 'tree'}/${tree.commit}/${path.split('/').map(encodeURIComponent).join('/')}` : null;
    },
  });
  /** How a chapter the model wrote becomes a page: its diagrams are mended, pictures it could only have invented are dropped. */
  const fromModel: PageContext = {
    diagramAlt: words.diagram,
    drawDiagram: (code) => drawDiagram(code, true),
    loadImage: async () => null,
    resolveLink: (href) => (/^https?:/i.test(href) ? href : null),
  };

  const fileLink = (path: string) => (tree ? `${repo.url}/blob/${tree.commit}/${path.split('/').map(encodeURIComponent).join('/')}` : `${repo.url}`);
  const facts = (rows: [string, string][]) => `<div class="table"><table class="facts">${rows.filter(([, v]) => v).map(([k, v]) => `<tr><th>${escapeXml(k)}</th><td>${v}</td></tr>`).join('')}</table></div>`;
  const stat = (f: { additions: number; deletions: number }) => `<span class="stat"><span class="plus">+${f.additions}</span> <span class="minus">−${f.deletions}</span></span>`;

  // ---- 2 and 3. The written kinds: a plan, then the chapters ----
  let outline: Outline | null = null;
  if (provider) {
    const single = req.kind === 'article';
    const magazine = req.kind === 'magazine' || single;
    outline = draft.outline;
    if (!outline && single) {
      // One article needs no plan from the model: it is written from the files that tell the most about
      // the project, or from the largest of the changes — as many as one request holds.
      const files = tree
        ? [...sources].sort((a, b) => weight(b, folder) - weight(a, folder)).slice(0, 8).map((f) => f.path)
        : (change!.files.some((f) => f.patch) ? change!.files.filter((f) => f.patch && !SKIP_FILES.test(f.path)) : change!.files)
            .slice()
            .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
            .slice(0, 12)
            .map((f) => f.path);
      outline = { title: '', subtitle: plainSubtitle, chapters: [{ title: '', brief: '', files }] };
      draft.outline = outline;
    }
    if (!outline) {
      let count: number;
      let paths: string[];
      let digest: string;
      if (tree) {
        const ranked = [...sources].sort((a, b) => weight(b, folder) - weight(a, folder));
        count = Math.min(size.chapters, Math.max(2, sources.length));
        // The list of files, the most telling first, as far as the model's room allows.
        const lines: string[] = [];
        let used = 0;
        for (const f of ranked) {
          const line = `${f.path} · ${kb(f.size)}`;
          if (used + line.length + 1 > budget * 0.4 && lines.length >= 20) break;
          lines.push(line);
          used += line.length + 1;
        }
        const listed = new Set(lines.map((l) => l.slice(0, l.lastIndexOf(' · '))));
        const left = new Map<string, number>();
        for (const f of sources) if (!listed.has(f.path)) left.set(dirOf(f.path) || '.', (left.get(dirOf(f.path) || '.') ?? 0) + 1);
        const readme = ranked.find((f) => /^readme(\.|$)/i.test(nameOf(f.path)));
        const manifest = MANIFESTS.map((m) => sources.find((f) => f.path === (folder ? `${folder}/${m}` : m))).find(Boolean);
        const readmeText = readme ? ((await readText(readme.path)) ?? '').slice(0, Math.min(12_000, budget * 0.3)) : '';
        const manifestText = manifest ? ((await readText(manifest.path)) ?? '').slice(0, Math.min(4_000, budget * 0.1)) : '';
        const shares = languageShares(sources);
        digest = [
          `Repository: ${repo.fullName}`,
          repo.description ? `Description: ${repo.description}` : null,
          repo.topics.length ? `Topics: ${repo.topics.join(', ')}` : null,
          `Reading: the branch ${ref}${folder ? `, only the folder ${folder}/` : ''}`,
          shares ? `Languages by size: ${shares}` : null,
          `\nFiles (${sources.length}${lines.length < sources.length ? `; the ${lines.length} most telling are listed` : ''}) — path · size:`,
          ...lines.sort(),
          left.size ? `Not listed: ${[...left].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([dir, n]) => `${dir}/ (${n})`).join(', ')}` : null,
          readmeText ? `\n${readme!.path} (the start):\n"""\n${readmeText}\n"""` : null,
          manifestText ? `\n${manifest!.path}:\n"""\n${manifestText}\n"""` : null,
        ]
          .filter((l): l is string => l !== null)
          .join('\n');
        paths = [...listed];
      } else {
        const c = change!;
        const substance = c.files.filter((f) => f.patch && !SKIP_FILES.test(f.path));
        paths = c.files.map((f) => f.path);
        count = Math.max(2, Math.min(size.chapters, Math.ceil(substance.length / 2) + 1));
        digest = [
          `Repository: ${repo.fullName}${repo.description ? ` — ${repo.description}` : ''}`,
          `Changes: ${c.label}${c.title ? ` — "${c.title}"` : ''}; ${c.base} ← ${c.head}; ${c.filesTotal} files, +${c.additions} −${c.deletions}`,
          c.body ? `\nDescription:\n"""\n${c.body.slice(0, Math.min(6_000, budget * 0.25))}\n"""` : null,
          `\nCommits (${c.commitsTotal}):`,
          ...c.commits.slice(0, 60).map((x) => `- ${x.message.split('\n')[0].slice(0, 160)}`),
          '\nChanged files — path · status · lines added/removed:',
          ...c.files.slice(0, 400).map((f) => `${f.path} · ${f.status} · +${f.additions} −${f.deletions}`),
        ]
          .filter((l): l is string => l !== null)
          .join('\n');
      }

      total = count + 4;
      say('Модель складає план…');
      for (let attempt = 0; attempt < 2 && !outline; attempt++) {
        stopped();
        try {
          const reply = await complete(provider, {
            system: outlineSystem(req, count, change),
            user: attempt ? `${digest}\n\nReply with the JSON object only, with "files" copied from the list above.` : digest,
            signal,
          });
          outline = readOutline(reply.text, paths, count);
        } catch (err) {
          if (signal.aborted || err instanceof RefusedError || attempt) throw err;
        }
      }
      // A model that cannot keep to the format still gets a book: the plan follows the folders.
      outline ??= folderOutline(tree ? sources : null, change, folder, count, words, (f) => weight(f, folder));
      if (!outline.title) outline.title = plainTitle;
      if (!outline.subtitle) outline.subtitle = plainSubtitle;
      draft.outline = outline;
    }
    const chapters = outline.chapters;
    total = chapters.length + 4;
    done = 2;

    const system = chapterSystem(req, change);
    const plan = chapters.map((c, i) => `${i + 1}. ${c.title}${c.brief ? ` — ${c.brief}` : ''}`).join('\n');
    const progress = new Map<number, number>();
    let lastSaid = 0;
    const writing = () => {
      if (Date.now() - lastSaid < 250) return;
      lastSaid = Date.now();
      const now = [...progress].map(([i, n]) => `${i + 1} (${n.toLocaleString('uk-UA')} зн.)`).join(', ');
      if (single) say(`Пишу статтю${progress.size ? `: ${(progress.get(0) ?? 0).toLocaleString('uk-UA')} зн.` : '…'}`);
      else say(`${magazine ? 'Пишу статті' : 'Пишу розділи'}: ${done - 2} з ${chapters.length} готово${now ? ` · зараз ${now}` : ''}`);
    };
    done = 2 + draft.chapters.size;
    writing();

    await inParallel(chapters.length, provider.kind === 'anthropic' ? 3 : 1, async (i) => {
      if (draft.chapters.has(i)) return;
      stopped();
      const chapter = chapters[i];
      let material: string;
      if (tree) {
        const each = Math.max(1_500, Math.floor(budget / chapter.files.length));
        const parts: string[] = [];
        for (const path of chapter.files) {
          const text = await readText(path).catch(() => null);
          if (text === null) continue;
          const cut = text.length > each ? `${text.slice(0, each)}\n[… the rest of the file is omitted: ${text.slice(each).split('\n').length} more lines]` : text;
          parts.push(`<file path="${path}">\n${cut}\n</file>`);
        }
        material = parts.join('\n\n') || '(none of the files planned for this chapter could be read)';
      } else {
        const c = change!;
        const mine = chapter.files.map((p) => c.files.find((f) => f.path === p)).filter((f): f is ChangedFile => Boolean(f));
        const each = Math.max(1_500, Math.floor((budget * 0.85) / Math.max(1, mine.length)));
        material = [
          `Changes: ${c.label}${c.title ? ` — "${c.title}"` : ''} (${c.base} ← ${c.head})`,
          c.body && `Description:\n"""\n${c.body.slice(0, Math.min(3_000, budget * 0.15))}\n"""`,
          ...mine.map((f) => {
            const patch = f.patch ? (f.patch.length > each ? `${f.patch.slice(0, each)}\n[… the rest of this diff is omitted]` : f.patch) : '(a binary file, or a diff too large to show)';
            return `<change path="${f.path}" status="${f.status}"${f.previousPath ? ` was="${f.previousPath}"` : ''} added="${f.additions}" removed="${f.deletions}">\n${patch}\n</change>`;
          }),
        ]
          .filter(Boolean)
          .join('\n\n');
      }
      const user = single
        ? `Write the article.\n\nSources:\n\n${material}`
        : `The plan of the whole ${magazine ? 'issue' : 'book'} "${outline!.title}":\n${plan}\n\nWrite ${magazine ? 'article' : 'chapter'} ${i + 1}: "${chapter.title}".${chapter.brief ? `\nWhat it covers: ${chapter.brief}` : ''}\n\nSources:\n\n${material}`;
      progress.set(i, 0);
      let text = '';
      for (let attempt = 0; attempt < 2 && !text; attempt++) {
        try {
          const reply = await complete(provider!, { system, user, signal, onProgress: (n) => (progress.set(i, n), writing()) });
          // An article brings its own headline: it names the article and the book made of it.
          text = tidyChapter(reply.text, chapter.title, single ? (headline) => (outline!.title = chapter.title = headline) : undefined);
        } catch (err) {
          // One more try for a dropped connection; a refusal or a stop is final.
          if (signal.aborted || err instanceof RefusedError || attempt) {
            const reason = err instanceof Error ? err.message : String(err);
            throw signal.aborted ? err : new Error(single ? `Стаття: ${reason}` : `${magazine ? 'Стаття' : 'Розділ'} ${i + 1} («${chapter.title}»): ${reason}`);
          }
        }
      }
      progress.delete(i);
      draft.chapters.set(i, text);
      done++;
      lastSaid = 0;
      writing();
    });
    // A model that gave its article no headline: the article is named after what it is about.
    if (single && !outline.title) outline.title = chapters[0].title = plainTitle;
  }

  // ---- 4. Pages ----
  stopped();
  total = Math.max(total, done + 2);
  say('Складаю сторінки й малюю діаграми…');
  const title = cleanText(outline?.title || plainTitle);
  const subtitle = cleanText(outline?.subtitle ?? plainSubtitle);
  const today = new Date().toLocaleDateString(req.lang, { day: 'numeric', month: 'long', year: 'numeric' });

  // The page about what the book was made from.
  let about = '';
  if (tree) {
    const dirs = new Map<string, number>();
    for (const f of sources) {
      const rel = folder ? f.path.slice(folder.length + 1) : f.path;
      const parts = rel.split('/');
      // Folders of tooling (".github") say nothing about how the program is put together.
      if (parts[0].startsWith('.')) continue;
      if (parts.length > 1) dirs.set(parts[0], (dirs.get(parts[0]) ?? 0) + 1);
      if (parts.length > 2) dirs.set(`${parts[0]}/${parts[1]}`, (dirs.get(`${parts[0]}/${parts[1]}`) ?? 0) + 1);
    }
    const label = (s: string) => s.replace(/["[\]{}()<>|`#;&]/g, ' ').trim();
    const top = [...dirs].filter(([d]) => !d.includes('/')).sort((a, b) => b[1] - a[1]).slice(0, 7);
    let map: { file: string; width: number } | null = null;
    if (top.length >= 2) {
      const lines = ['flowchart LR', `  R["${label(folder ? nameOf(folder) : repo.name)}"]`];
      top.forEach(([dir, n], i) => {
        lines.push(`  R --> D${i}["${label(dir)}/ · ${n}"]`);
        [...dirs]
          .filter(([d]) => d.startsWith(`${dir}/`))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .forEach(([sub, m], j) => lines.push(`  D${i} --> D${i}S${j}["${label(nameOf(sub))}/ · ${m}"]`));
      });
      map = await drawDiagram(lines.join('\n'), false);
    }
    about = [
      `<h1>${escapeXml(words.aboutRepo)}</h1>`,
      repo.description ? `<p>${escapeXml(repo.description)}</p>` : '',
      facts([
        [words.repository, `<a href="${escapeXml(repo.url)}">${escapeXml(repo.fullName)}</a>`],
        [words.branch, escapeXml(ref)],
        [words.folder, folder ? `<code>${escapeXml(folder)}/</code>` : ''],
        [words.commit, `<a href="${escapeXml(`${repo.url}/commit/${tree.commit}`)}"><code>${tree.commit.slice(0, 7)}</code></a>`],
        [words.languages, escapeXml(languageShares(sources))],
        [words.files, String(sources.length)],
        [words.stars, repo.stars ? repo.stars.toLocaleString(req.lang) : ''],
        [words.license, escapeXml(repo.license)],
      ]),
      map ? `<figure class="diagram"><img src="${map.file}" width="${Math.round(map.width)}" alt="${escapeXml(words.map)}"/><figcaption>${escapeXml(words.map)}</figcaption></figure>` : '',
    ].join('\n');
  } else {
    const c = change!;
    const described = c.body.trim() ? await markdownToXhtml(c.body, fromRepo(''), 'about') : null;
    const shown = c.files.slice(0, 80);
    about = [
      `<h1>${escapeXml(words.aboutChanges)}</h1>`,
      facts([
        [words.repository, `<a href="${escapeXml(repo.url)}">${escapeXml(repo.fullName)}</a>`],
        [c.type === 'pull' ? 'Pull request' : c.type === 'commit' ? words.commit : words.comparison, `<a href="${escapeXml(c.url)}">${escapeXml(c.label)}</a>${c.title ? ` — ${escapeXml(c.title)}` : ''}`],
        [words.branch, c.type === 'commit' ? '' : `<code>${escapeXml(c.base)}</code> ← <code>${escapeXml(c.head)}</code>`],
        [words.author, escapeXml(c.author)],
        [words.state, escapeXml(c.state)],
        [words.commits, String(c.commitsTotal)],
        [words.changed, `${c.filesTotal} · ${stat(c)}`],
      ]),
      described ? `<h2>${escapeXml(words.description)}</h2>\n${described.body}` : '',
      `<h2>${escapeXml(words.changed)}</h2>`,
      `<div class="table"><table>${shown.map((f) => `<tr><td><code>${escapeXml(f.path)}</code></td><td>${stat(f)}</td></tr>`).join('')}</table></div>`,
      c.filesTotal > shown.length ? `<p class="note">… +${c.filesTotal - shown.length}</p>` : '',
      c.type !== 'commit' ? `<h2>${escapeXml(words.commits)}</h2>\n<ul>${c.commits.slice(0, 60).map((x) => `<li><code>${x.sha.slice(0, 7)}</code> ${escapeXml(x.message.split('\n')[0].slice(0, 200))}${x.author ? ` — ${escapeXml(x.author)}` : ''}</li>`).join('')}</ul>` : '',
    ].join('\n');
  }

  let plainNote = '';
  const body: typeof pages = [];
  const bodyToc: EpubToc[] = [];
  if (outline) {
    for (let i = 0; i < outline.chapters.length; i++) {
      const chapter = outline.chapters[i];
      const name = `ch${String(i + 1).padStart(2, '0')}.xhtml`;
      const page = await markdownToXhtml(draft.chapters.get(i) ?? '', fromModel, `s${i + 1}`);
      let text = page.body;
      // A magazine piece opens with its lead set apart.
      if (magazineLook) text = text.replace(/^<p /, '<p class="lead" ');
      const kicker = magazineLook ? repo.name : `${words.chapter} ${i + 1}`;
      body.push({ name, title: chapter.title, body: `<p class="kicker">${escapeXml(kicker)}</p>\n<h1>${escapeXml(chapter.title)}</h1>\n${text}` });
      bodyToc.push({ title: chapter.title, href: name, depth: 1 }, ...page.headings.map((h) => ({ title: h.title, href: `${name}#${h.id}`, depth: 2 })));
    }
    if (tree) {
      body.push({
        name: 'sources.xhtml',
        title: words.sources,
        body: `<h1>${escapeXml(words.sources)}</h1>\n<p class="note">${escapeXml(words.sourcesIntro)}</p>\n${outline.chapters
          .map((c, i) => `<h3>${i + 1}. ${escapeXml(c.title)}</h3>\n<ul>${c.files.map((p) => `<li><a href="${escapeXml(fileLink(p))}"><code>${escapeXml(p)}</code></a></li>`).join('')}</ul>`)
          .join('\n')}`,
      });
      bodyToc.push({ title: words.sources, href: 'sources.xhtml', depth: 1 });
    }
  } else if (tree) {
    // The code as it is: as many of the files as the chosen size holds, the most telling first.
    const ranked = [...sources].sort((a, b) => weight(b, folder) - weight(a, folder));
    const chosen: TreeFile[] = [];
    let sum = 0;
    for (const f of ranked) {
      if (chosen.length >= 600) break;
      if (sum + f.size > size.plainChars && chosen.length) continue;
      chosen.push(f);
      sum += f.size;
    }
    const rank = (f: TreeFile) => {
      const rel = folder ? f.path.slice(folder.length + 1) : f.path;
      if (rel.includes('/')) return 3;
      return /^readme(\.|$)/i.test(rel) ? 0 : DOC.test(rel) ? 1 : 2;
    };
    chosen.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, 'en', { numeric: true }));
    if (chosen.length < sources.length) plainNote = words.partOnly.replace('{n}', String(chosen.length)).replace('{of}', String(sources.length));
    total = chosen.length + 3;
    done = 1;
    const loaded = new Array<string | null>(chosen.length).fill(null);
    await inParallel(chosen.length, 6, async (i) => {
      stopped();
      loaded[i] = await readText(chosen[i].path).catch(() => null);
      done++;
      say(`Завантажую файли: ${done - 1} з ${chosen.length}…`);
    });
    say('Складаю сторінки…');
    let lastDir: string | null = null;
    for (let i = 0; i < chosen.length; i++) {
      const text = loaded[i];
      if (text === null) continue;
      const path = chosen[i].path;
      const rel = folder ? path.slice(folder.length + 1) : path;
      const name = `f${String(body.length + 1).padStart(4, '0')}.xhtml`;
      const content = DOC.test(path) ? (await markdownToXhtml(text, fromRepo(dirOf(path)), `f${body.length + 1}`)).body : codeHtml(text);
      body.push({ name, title: rel, body: `<h1 class="path">${escapeXml(rel)}</h1>\n${content}` });
      const dir = dirOf(rel);
      if (dir && dir !== lastDir) bodyToc.push({ title: `${dir}/`, href: name, depth: 1 });
      lastDir = dir;
      bodyToc.push({ title: nameOf(rel), href: name, depth: dir ? 2 : 1 });
    }
  }
  // The diffs themselves: the whole of a book made without a model, an appendix to a written one.
  if (change) {
    const c = change;
    let room = size.patchChars;
    const parts: string[] = [];
    let listed = 0;
    for (const f of c.files) {
      if (room <= 0) break;
      listed++;
      const head = `<h2 id="c${listed}"><code>${escapeXml(f.path)}</code> ${stat(f)}</h2>${f.previousPath ? `\n<p class="note">← <code>${escapeXml(f.previousPath)}</code></p>` : ''}`;
      if (!f.patch) {
        parts.push(`${head}\n<p class="note">${escapeXml(words.noPatch)}</p>`);
        continue;
      }
      const patch = f.patch.length > room ? `${f.patch.slice(0, room)}\n… ${words.cut}` : f.patch;
      room -= patch.length;
      parts.push(`${head}\n${diffHtml(patch)}`);
    }
    if (listed < c.files.length) parts.push(`<p class="note">… +${c.files.length - listed}: <a href="${escapeXml(c.url)}">${escapeXml(c.label)}</a></p>`);
    body.push({ name: 'changes.xhtml', title: words.allChanges, body: `<h1>${escapeXml(words.allChanges)}</h1>\n${parts.join('\n')}` });
    bodyToc.push({ title: words.allChanges, href: 'changes.xhtml', depth: 1 });
    if (!outline) c.files.slice(0, listed).forEach((f, i) => bodyToc.push({ title: f.path, href: `changes.xhtml#c${i + 1}`, depth: 2 }));
  }

  const note = provider ? words.writtenBy.replace('{model}', provider.name) : words.noAi;
  const coverLabel = req.kind === 'magazine' ? words.magazine : req.kind === 'article' ? words.article : req.kind === 'plain' ? words.plain : words.book;
  // The cover is a page of its own: a book opened for the first time shows it, not the text under it.
  pages.push({ name: 'cover.xhtml', title, body: `<div class="cover"><img src="images/cover.jpg" alt="${escapeXml(title)}"/></div>` });
  pages.push({
    name: 'title.xhtml',
    title,
    body: `<p class="kicker">${escapeXml(coverLabel)}</p>\n<h1 class="book-title">${escapeXml(title)}</h1>\n${subtitle ? `<p class="book-subtitle">${escapeXml(subtitle)}</p>\n` : ''}<p class="book-meta"><a href="${escapeXml(sourceUrl)}">${escapeXml(repo.fullName)}</a> · ${escapeXml(what)} · ${escapeXml(today)}</p>\n<p class="note">${escapeXml(note)}</p>`,
  });
  toc.push({ title, href: 'cover.xhtml', depth: 1 });
  pages.push({ name: 'about.xhtml', title: tree ? words.aboutRepo : words.aboutChanges, body: `${about}${plainNote ? `\n<p class="note">${escapeXml(plainNote)}</p>` : ''}` });
  toc.push({ title: tree ? words.aboutRepo : words.aboutChanges, href: 'about.xhtml', depth: 1 });
  pages.push(...body);
  toc.push(...bodyToc);

  stopped();
  say('Малюю обкладинку й збираю книжку…');
  const cover = await drawCover({
    // An article is a piece out of a magazine and looks like one, only with nothing else in the issue.
    kind: req.kind === 'article' ? 'magazine' : req.kind,
    title,
    subtitle,
    repo: repo.fullName,
    what,
    label: coverLabel,
    dateLine: req.kind === 'article' ? today : `${words.issueOf} ${today}`,
    listTitle: words.inThisIssue,
    list:
      req.kind === 'article'
        ? []
        : req.kind === 'magazine'
          ? outline?.chapters.map((c) => c.title)
          : tree
            ? [...new Set(sources.map((f) => (folder ? f.path.slice(folder.length + 1) : f.path).split('/')[0]))].slice(0, 9)
            : change!.files.slice(0, 9).map((f) => nameOf(f.path)),
  });
  images.unshift({ file: 'images/cover.jpg', type: 'image/jpeg', data: cover });

  const epub = await buildEpub({
    id: `urn:zakladka:repo:${repo.fullName}:${what}:${Date.now()}`,
    title,
    authors: [repo.fullName],
    lang: req.lang,
    css: magazineLook ? BOOK_CSS + MAGAZINE_CSS : BOOK_CSS,
    files: pages,
    images,
    cover: 'images/cover.jpg',
    toc,
    tocTitle: words.contents,
  });
  stopped();
  const fileName = `${`${repo.name} — ${what}`.replace(/[\\/:*?"<>|…]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)}.epub`;
  const result = await importBooks([new File([epub], fileName, { type: 'application/epub+zip' })]);
  const id = result.ids[0];
  if (!id) throw new Error(result.errors[0] ?? 'Не вдалося зберегти книжку.');
  const book = await db.books.get(id);
  const made: BookMade = { from: 'github', kind: req.kind, repo: repo.fullName, what, lang: req.lang, ...(provider ? { model: provider.name } : {}) };
  if (book) await db.books.update(id, { title, author: `${repo.fullName} · ${what}`, sourceUrl, made, tags: [...new Set([...(book.tags ?? []), REPO_SHELF])], infoAt: Date.now() });
  done = total;
  say('Готово');
  return id;
}

/** A plan made without a model: an overview, then the largest folders (or groups of changed files). */
function folderOutline(sources: TreeFile[] | null, change: ChangeSet | null, folder: string, count: number, words: BookWords, weigh: (f: TreeFile) => number): Outline {
  const chapters: OutlineChapter[] = [];
  if (sources) {
    const rel = (f: TreeFile) => (folder ? f.path.slice(folder.length + 1) : f.path);
    const best = (list: TreeFile[]) => [...list].sort((a, b) => weigh(b) - weigh(a)).slice(0, 5).map((f) => f.path);
    const root = sources.filter((f) => !rel(f).includes('/'));
    if (root.length) chapters.push({ title: words.overview, brief: '', files: best(root) });
    const groups = new Map<string, TreeFile[]>();
    for (const f of sources) {
      const parts = rel(f).split('/');
      if (parts.length < 2) continue;
      // One folder holding nearly everything ("src") is told by its own folders.
      const group = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
      groups.set(group, [...(groups.get(group) ?? []), f]);
    }
    const ranked = [...groups].sort((a, b) => b[1].reduce((n, f) => n + f.size, 0) - a[1].reduce((n, f) => n + f.size, 0));
    for (const [group, list] of ranked) {
      if (chapters.length >= count) break;
      chapters.push({ title: `${group}/`, brief: '', files: best(list) });
    }
  } else if (change) {
    const groups = new Map<string, string[]>();
    for (const f of change.files.filter((x) => x.patch)) {
      const group = f.path.split('/').slice(0, 2).join('/');
      groups.set(group, [...(groups.get(group) ?? []), f.path]);
    }
    for (const [group, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      if (chapters.length >= count) break;
      chapters.push({ title: group, brief: '', files: list.slice(0, 6) });
    }
    if (!chapters.length) chapters.push({ title: words.allChanges, brief: '', files: change.files.slice(0, 6).map((f) => f.path) });
  }
  return { title: '', subtitle: '', chapters };
}
