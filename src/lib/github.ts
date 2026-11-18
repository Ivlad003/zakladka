// Reading a GitHub repository for the books the app makes from one (lib/repo-book.ts): the
// repository at a branch, a pull request, a comparison of two branches, a single commit.
// The browser asks GitHub's public API itself — it answers pages of other sites — so nothing passes
// through the app's server, and it works in the build on GitHub Pages too.
import { getSettings } from '../settings';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

/** What of a repository is to be read. */
export type RepoTarget =
  | { type: 'repo'; ref: string; /** Only this folder of it ("" for all). */ path: string }
  | { type: 'pull'; number: number }
  | { type: 'compare'; base: string; head: string }
  | { type: 'commit'; sha: string };

export interface RepoAddress {
  owner: string;
  name: string;
  /** What the address points at, as far as it says. */
  hint:
    | { type: 'pull'; number: number }
    | { type: 'compare'; base: string; head: string }
    | { type: 'commit'; sha: string }
    /** "tree/<branch>/<folder>": where the branch name ends is known only with the list of branches. */
    | { type: 'tree'; refPath: string }
    | null;
}

/**
 * A repository from what the reader typed or pasted: "owner/name", an address of the repository, of
 * a branch or a folder in it, of a pull request, of a comparison, of a commit, or a clone address.
 */
export function parseRepoAddress(text: string): RepoAddress | null {
  let t = text.trim();
  if (!t) return null;
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(t);
  if (ssh) return { owner: ssh[1], name: ssh[2], hint: null };
  t = t.replace(/^https?:\/\//i, '').replace(/^(www\.)?github\.com\//i, '');
  // Whatever is left has to look like "owner/name[/…]", not like the address of another site.
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)(?:\/([^?#]*))?(?:[?#].*)?$/.exec(t);
  if (!m) return null;
  const owner = m[1];
  const name = m[2].replace(/\.git$/i, '');
  if (!name || name === '.' || name === '..') return null;
  const rest = (m[3] ?? '').replace(/\/+$/, '');
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  let hint: RepoAddress['hint'] = null;
  const pull = /^pull\/(\d+)/.exec(rest);
  const compare = /^compare\/(.+?)\.{2,3}(.+)$/.exec(rest);
  const commit = /^commit\/([0-9a-f]{7,40})/i.exec(rest);
  const tree = /^(?:tree|blob|commits)\/(.+)$/.exec(rest);
  if (pull) hint = { type: 'pull', number: Number(pull[1]) };
  else if (compare) hint = { type: 'compare', base: decode(compare[1]), head: decode(compare[2]) };
  else if (commit) hint = { type: 'commit', sha: commit[1] };
  else if (tree) hint = { type: 'tree', refPath: decode(tree[1]) };
  return { owner, name, hint };
}

/** Splits "feature/x/src/lib" into the branch and the folder, given the branches there are. */
export function splitRefPath(refPath: string, branches: string[]): { ref: string; path: string } {
  const known = branches.filter((b) => refPath === b || refPath.startsWith(`${b}/`)).sort((a, b) => b.length - a.length)[0];
  if (known) return { ref: known, path: refPath.slice(known.length + 1) };
  // A tag or a commit: those have no slashes of their own in the usual case.
  const [ref, ...rest] = refPath.split('/');
  return { ref, path: rest.join('/') };
}

const encPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const token = () => getSettings().githubToken.trim();

/** Answers already had from GitHub: a reader going back and forth in the dialog does not spend the request limit twice. */
const kept = new Map<string, { at: number; value: unknown }>();
const KEEP_MS = 10 * 60_000;

function failure(res: Response, body: string): GithubError {
  let said = '';
  try {
    said = (JSON.parse(body) as { message?: string }).message ?? '';
  } catch {
    // Not JSON: the status alone will have to do.
  }
  const hasToken = Boolean(token());
  if (res.status === 401) return new GithubError(401, 'GitHub не прийняв токен: він недійсний або прострочений. Перевірте його або приберіть.');
  if ((res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(said))) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const when = reset ? ` Ліміт оновиться о ${new Date(reset * 1000).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}.` : '';
    return new GithubError(
      res.status,
      hasToken ? `Вичерпано ліміт запитів GitHub для цього токена.${when}` : `GitHub дозволяє без токена 60 запитів на годину, і вони скінчилися.${when} З токеном GitHub ліміт — 5000 на годину.`,
    );
  }
  if (res.status === 403) return new GithubError(403, `GitHub відмовив у доступі${said ? `: ${said}` : ''}. ${hasToken ? 'Перевірте, чи має токен доступ до цього репозиторію.' : 'Для приватного репозиторію потрібен токен.'}`);
  if (res.status === 404) return new GithubError(404, hasToken ? 'GitHub такого не знайшов: перевірте адресу й чи має токен доступ до цього репозиторію.' : 'GitHub такого не знайшов: перевірте адресу. Якщо репозиторій приватний, додайте токен GitHub.');
  if (res.status === 409) return new GithubError(409, 'Цей репозиторій порожній: у ньому ще немає жодного коміту.');
  if (res.status === 422) return new GithubError(422, `GitHub не зміг це показати${said ? `: ${said}` : ''}.`);
  return new GithubError(res.status, `GitHub відповів помилкою ${res.status}${said ? `: ${said}` : ''}.`);
}

async function ask(path: string, signal?: AbortSignal, accept = 'application/vnd.github+json'): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept };
  const auth = token();
  if (auth) headers.Authorization = `Bearer ${auth}`;
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { headers, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new GithubError(0, 'Немає з’єднання з GitHub. Перевірте інтернет і спробуйте ще раз.');
  }
  if (!res.ok) throw failure(res, await res.text().catch(() => ''));
  return res;
}

async function json<T>(path: string, signal?: AbortSignal): Promise<T> {
  const key = `${token() ? 'auth' : 'anon'} ${path}`;
  const had = kept.get(key);
  if (had && Date.now() - had.at < KEEP_MS) return had.value as T;
  const value = (await (await ask(path, signal)).json()) as T;
  if (kept.size > 200) kept.clear();
  kept.set(key, { at: Date.now(), value });
  return value;
}

export interface RepoInfo {
  owner: string;
  name: string;
  /** "owner/name" with the letter case GitHub has it in. */
  fullName: string;
  description: string;
  defaultBranch: string;
  isPrivate: boolean;
  stars: number;
  language: string;
  license: string;
  topics: string[];
  url: string;
}

interface ApiRepo {
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  default_branch: string;
  private: boolean;
  stargazers_count: number;
  language: string | null;
  license: { spdx_id?: string | null; name?: string } | null;
  topics?: string[];
  html_url: string;
}

export async function getRepo(owner: string, name: string, signal?: AbortSignal): Promise<RepoInfo> {
  const r = await json<ApiRepo>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, signal);
  const spdx = r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : (r.license?.name ?? '');
  return {
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    description: r.description ?? '',
    defaultBranch: r.default_branch,
    isPrivate: r.private,
    stars: r.stargazers_count,
    language: r.language ?? '',
    license: spdx,
    topics: r.topics ?? [],
    url: r.html_url,
  };
}

const base = (repo: Pick<RepoInfo, 'owner' | 'name'>) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

/** Branch names, the first three hundred of them. */
export async function listBranches(repo: RepoInfo, signal?: AbortSignal): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const list = await json<{ name: string }[]>(`${base(repo)}/branches?per_page=100&page=${page}`, signal);
    names.push(...list.map((b) => b.name));
    if (list.length < 100) break;
  }
  // The default branch first, the rest as GitHub orders them.
  return [...new Set([repo.defaultBranch, ...names])].filter((n) => n === repo.defaultBranch || names.includes(n));
}

export interface PullSummary {
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  author: string;
  base: string;
  head: string;
  draft: boolean;
}

interface ApiPull {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  merged_at: string | null;
  merged?: boolean;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string; label?: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

const pullState = (p: ApiPull): PullSummary['state'] => (p.merged_at || p.merged ? 'merged' : p.state === 'open' ? 'open' : 'closed');

/** The pull requests touched most recently, open and closed alike. */
export async function listPulls(repo: RepoInfo, signal?: AbortSignal): Promise<PullSummary[]> {
  const list = await json<ApiPull[]>(`${base(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=40`, signal);
  return list.map((p) => ({ number: p.number, title: p.title, state: pullState(p), author: p.user?.login ?? '', base: p.base.ref, head: p.head.ref, draft: Boolean(p.draft) }));
}

export interface TreeFile {
  path: string;
  size: number;
}

export interface RepoTree {
  /** The commit the tree was read at; file contents are fetched at the same one. */
  commit: string;
  files: TreeFile[];
  /** GitHub cut the listing short (a very large repository). */
  truncated: boolean;
}

export async function getTree(repo: RepoInfo, ref: string, signal?: AbortSignal): Promise<RepoTree> {
  const key = `sha ${repo.fullName} ${ref}`;
  const had = kept.get(key);
  let commit = had && Date.now() - had.at < KEEP_MS ? (had.value as string) : '';
  if (!commit) {
    commit = (await (await ask(`${base(repo)}/commits/${encPath(ref)}`, signal, 'application/vnd.github.sha')).text()).trim();
    kept.set(key, { at: Date.now(), value: commit });
  }
  const tree = await json<{ tree: { path: string; type: string; size?: number }[]; truncated?: boolean }>(`${base(repo)}/git/trees/${commit}?recursive=1`, signal);
  return {
    commit,
    files: tree.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: e.size ?? 0 })),
    truncated: Boolean(tree.truncated),
  };
}

/** The bytes of a file as it is at `commit`. */
export async function getFileBytes(repo: RepoInfo, commit: string, path: string, signal?: AbortSignal): Promise<Uint8Array> {
  // Without a token the file comes from the raw host, which does not count towards the API's hourly limit.
  if (!token() && !repo.isPrivate) {
    try {
      const res = await fetch(`${RAW}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${commit}/${encPath(path)}`, { signal });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (signal?.aborted) throw err;
      // The raw host may be unreachable where the API is not: ask the API below.
    }
  }
  const res = await ask(`${base(repo)}/contents/${encPath(path)}?ref=${commit}`, signal, 'application/vnd.github.raw+json');
  return new Uint8Array(await res.arrayBuffer());
}

/** The text of a file, or null when it is not text. */
export async function getFileText(repo: RepoInfo, commit: string, path: string, signal?: AbortSignal): Promise<string | null> {
  const bytes = await getFileBytes(repo, commit, path, signal);
  if (bytes.subarray(0, 8000).includes(0)) return null;
  return new TextDecoder('utf-8').decode(bytes).replace(/^\u{FEFF}/u, '').replace(/\r\n?/g, '\n');
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  /** The diff of the file in the unified format; absent for binary files and for very large diffs. */
  patch?: string;
}

export interface ChangeCommit {
  sha: string;
  message: string;
  author: string;
}

/** A set of changes to read: a pull request, the difference between two branches, one commit. */
export interface ChangeSet {
  type: 'pull' | 'compare' | 'commit';
  /** Short name: "PR #12", "main…feature", a commit's short hash. */
  label: string;
  /** A pull request's title, a commit's first line; empty for a comparison. */
  title: string;
  /** The description, in Markdown (a pull request's body, a commit's message after its first line). */
  body: string;
  author: string;
  /** "open", "merged", "closed" for a pull request. */
  state: string;
  base: string;
  head: string;
  url: string;
  commits: ChangeCommit[];
  files: ChangedFile[];
  additions: number;
  deletions: number;
  /** How many files changed in all; GitHub lists only so many of them. */
  filesTotal: number;
  commitsTotal: number;
}

interface ApiFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface ApiCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name?: string } | null };
  author: { login: string } | null;
  files?: ApiFile[];
  stats?: { additions: number; deletions: number };
}

const toFile = (f: ApiFile): ChangedFile => ({ path: f.filename, previousPath: f.previous_filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch });
const toCommit = (c: ApiCommit): ChangeCommit => ({ sha: c.sha, message: c.commit.message, author: c.author?.login ?? c.commit.author?.name ?? '' });
const sum = (files: ChangedFile[], key: 'additions' | 'deletions') => files.reduce((n, f) => n + f[key], 0);

export async function getPull(repo: RepoInfo, number: number, signal?: AbortSignal): Promise<ChangeSet> {
  const p = await json<ApiPull>(`${base(repo)}/pulls/${number}`, signal);
  const files: ChangedFile[] = [];
  // Each page is a request; without a token there are only sixty an hour.
  const pages = token() ? 10 : 3;
  for (let page = 1; page <= pages; page++) {
    const list = await json<ApiFile[]>(`${base(repo)}/pulls/${number}/files?per_page=100&page=${page}`, signal);
    files.push(...list.map(toFile));
    if (list.length < 100) break;
  }
  const commits = await json<ApiCommit[]>(`${base(repo)}/pulls/${number}/commits?per_page=100`, signal);
  return {
    type: 'pull',
    label: `PR #${number}`,
    title: p.title,
    body: p.body ?? '',
    author: p.user?.login ?? '',
    state: pullState(p),
    base: p.base.ref,
    head: p.head.label ?? p.head.ref,
    url: p.html_url,
    commits: commits.map(toCommit),
    files,
    additions: p.additions ?? sum(files, 'additions'),
    deletions: p.deletions ?? sum(files, 'deletions'),
    filesTotal: p.changed_files ?? files.length,
    commitsTotal: commits.length,
  };
}

/** What `head` has that `base` does not (the three-dot comparison, the same a pull request shows). */
export async function getCompare(repo: RepoInfo, baseRef: string, head: string, signal?: AbortSignal): Promise<ChangeSet> {
  const c = await json<{ html_url: string; total_commits: number; commits: ApiCommit[]; files?: ApiFile[] }>(
    `${base(repo)}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(head)}?per_page=100`,
    signal,
  );
  const files = (c.files ?? []).map(toFile);
  const commits = c.commits.map(toCommit);
  const authors = [...new Set(commits.map((x) => x.author).filter(Boolean))];
  return {
    type: 'compare',
    label: `${baseRef}…${head}`,
    title: '',
    body: '',
    author: authors.slice(0, 3).join(', '),
    state: '',
    base: baseRef,
    head,
    url: c.html_url,
    commits,
    files,
    additions: sum(files, 'additions'),
    deletions: sum(files, 'deletions'),
    filesTotal: files.length,
    commitsTotal: c.total_commits,
  };
}

export async function getCommit(repo: RepoInfo, sha: string, signal?: AbortSignal): Promise<ChangeSet> {
  const c = await json<ApiCommit>(`${base(repo)}/commits/${encodeURIComponent(sha)}`, signal);
  const files = (c.files ?? []).map(toFile);
  const [first, ...rest] = c.commit.message.split('\n');
  const one = toCommit(c);
  return {
    type: 'commit',
    label: c.sha.slice(0, 7),
    title: first,
    body: rest.join('\n').trim(),
    author: one.author,
    state: '',
    base: `${c.sha.slice(0, 7)}^`,
    head: c.sha.slice(0, 7),
    url: c.html_url,
    commits: [one],
    files,
    additions: c.stats?.additions ?? sum(files, 'additions'),
    deletions: c.stats?.deletions ?? sum(files, 'deletions'),
    filesTotal: files.length,
    commitsTotal: 1,
  };
}
