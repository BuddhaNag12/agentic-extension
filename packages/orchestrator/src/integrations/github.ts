/**
 * The GitHub read surface (§7.7), on `fetch` and nothing else.
 *
 * No octokit deliberately: the packaged `.vsix` ships no `node_modules`
 * (DECISIONS D42), so every dependency has to be vendored beside the bundle
 * the way the Agent SDK is. Node has had `fetch` since 18, and the six calls
 * §7.7 lists are plain REST.
 *
 * Read-only. §7.5 is emphatic that findings are never auto-posted, so nothing
 * here writes — publishing is a separate, human-triggered surface, and a
 * module that cannot write cannot be made to write by accident.
 */

export const GITHUB_API = 'https://api.github.com';

export interface RepoCoordinates {
  owner: string;
  name: string;
}

/** A PR as the inbox lists it — enough to choose one, not to review it. */
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  author: string;
  labels: string[];
  draft: boolean;
  updatedAt: string;
}

/** A PR as a review needs it (§7.2 intake). */
export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: boolean | undefined;
}

export type LabelFilter =
  /** Every PR, whatever it carries. */
  | { kind: 'any' }
  /** Only PRs carrying *all* of these labels. */
  | { kind: 'tagged'; labels: readonly string[] }
  /** Only PRs carrying no labels at all. */
  | { kind: 'untagged' };

export interface PrQuery {
  repo: RepoCoordinates;
  labels?: LabelFilter;
  state?: 'open' | 'closed' | 'all';
  /** Only PRs whose review was requested from the authenticated user. */
  reviewRequested?: boolean;
  author?: string;
  limit?: number;
}

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** Injectable so tests exercise the query building without a network. */
export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface GitHubOptions {
  token: string;
  api?: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

/**
 * `fetch` waits forever by default, and a request that never returns is worse
 * than one that fails: the spinner spins, nothing is logged, and there is
 * nothing to act on.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * `owner/name` from a git remote URL.
 *
 * Both forms, because a repo cloned over SSH and one cloned over HTTPS are the
 * same repo and a tool that only understands one of them looks broken to half
 * its users.
 */
export function parseRemote(url: string): RepoCoordinates | undefined {
  const cleaned = url.trim().replace(/\.git$/, '');
  const ssh = /^git@([^:]+):([^/]+)\/(.+)$/.exec(cleaned);
  if (ssh) return { owner: ssh[2]!, name: ssh[3]! };
  const https = /^https?:\/\/[^/]+\/([^/]+)\/(.+)$/.exec(cleaned);
  if (https) return { owner: https[1]!, name: https[2]! };
  const scp = /^ssh:\/\/git@[^/]+\/([^/]+)\/(.+)$/.exec(cleaned);
  if (scp) return { owner: scp[1]!, name: scp[2]! };
  return undefined;
}

/**
 * The search qualifier string for a query (§7.7 "Search issues/PRs").
 *
 * Label filtering happens server-side rather than by fetching everything and
 * filtering locally: a busy repo's open PRs run to hundreds, and paginating
 * all of them to show a handful is the difference between an inbox that opens
 * instantly and one nobody waits for.
 */
export function buildSearchQuery(q: PrQuery): string {
  const parts = [`repo:${q.repo.owner}/${q.repo.name}`, 'is:pr'];

  if (q.state !== 'all') parts.push(`is:${q.state ?? 'open'}`);
  if (q.reviewRequested) parts.push('review-requested:@me');
  if (q.author) parts.push(`author:${q.author}`);

  const labels = q.labels ?? { kind: 'any' };
  if (labels.kind === 'untagged') {
    parts.push('no:label');
  } else if (labels.kind === 'tagged') {
    // Repeated `label:` qualifiers are ANDed by GitHub search. Quoted, because
    // labels routinely contain spaces ("needs review", "good first issue").
    for (const l of labels.labels) parts.push(`label:"${l}"`);
  }
  return parts.join(' ');
}

export class GitHubClient {
  private readonly api: string;
  private readonly fetcher: Fetcher;

  constructor(private readonly opts: GitHubOptions) {
    this.api = opts.api ?? GITHUB_API;
    this.fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  }

  /** PRs matching the query, newest first. */
  async listPullRequests(q: PrQuery): Promise<PullRequestSummary[]> {
    const search = buildSearchQuery(q);
    const limit = Math.min(q.limit ?? 30, 100);
    const url =
      `${this.api}/search/issues?q=${encodeURIComponent(search)}` +
      `&sort=updated&order=desc&per_page=${limit}`;

    const body = await this.get<{ items?: unknown[] }>(url);
    return (body.items ?? []).map(toSummary);
  }

  /** One PR in the detail a review needs (§7.2). */
  async getPullRequest(repo: RepoCoordinates, number: number): Promise<PullRequestDetail> {
    const raw = await this.get<Record<string, unknown>>(
      `${this.api}/repos/${repo.owner}/${repo.name}/pulls/${number}`,
    );
    const head = (raw['head'] ?? {}) as Record<string, unknown>;
    const base = (raw['base'] ?? {}) as Record<string, unknown>;
    return {
      ...toSummary(raw),
      body: typeof raw['body'] === 'string' ? raw['body'] : '',
      baseRef: String(base['ref'] ?? ''),
      headRef: String(head['ref'] ?? ''),
      headSha: String(head['sha'] ?? ''),
      additions: Number(raw['additions'] ?? 0),
      deletions: Number(raw['deletions'] ?? 0),
      changedFiles: Number(raw['changed_files'] ?? 0),
      mergeable: typeof raw['mergeable'] === 'boolean' ? raw['mergeable'] : undefined,
    };
  }

  /** Every distinct label in the repo, for building a filter. */
  async listLabels(repo: RepoCoordinates): Promise<string[]> {
    const raw = await this.get<unknown[]>(
      `${this.api}/repos/${repo.owner}/${repo.name}/labels?per_page=100`,
    );
    return raw
      .map((l) => (l as { name?: unknown }).name)
      .filter((n): n is string => typeof n === 'string')
      .sort();
  }

  private async get<T>(url: string): Promise<T> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    let res: Awaited<ReturnType<Fetcher>>;
    try {
      res = await this.fetcher(url, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.opts.token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'agentflow',
        },
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) {
        throw new GitHubError(0, `GitHub did not respond within ${timeoutMs / 1000}s.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // The three that actually happen get their own message, because "GitHub
      // returned 404" sends someone looking for a missing PR when the real
      // problem is a token without access to a private repo.
      const detail = await res.text().catch(() => '');
      throw new GitHubError(res.status, describe(res.status, detail));
    }
    return (await res.json()) as T;
  }
}

function describe(status: number, detail: string): string {
  if (status === 401) return 'GitHub rejected the token (401). It may be expired or malformed.';
  if (status === 403) {
    return detail.includes('rate limit')
      ? 'GitHub rate limit reached (403). Wait, or use a token with a higher limit.'
      : 'GitHub refused the request (403). The token is probably missing the repository scope.';
  }
  if (status === 404) {
    return 'Not found (404) — which for a private repository usually means the token cannot see it, not that it is absent.';
  }
  return `GitHub returned ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
}

function toSummary(raw: unknown): PullRequestSummary {
  const o = (raw ?? {}) as Record<string, unknown>;
  const user = (o['user'] ?? {}) as Record<string, unknown>;
  const labels = Array.isArray(o['labels']) ? o['labels'] : [];
  return {
    number: Number(o['number'] ?? 0),
    title: String(o['title'] ?? ''),
    url: String(o['html_url'] ?? ''),
    author: String(user['login'] ?? 'unknown'),
    labels: labels
      .map((l) => (typeof l === 'string' ? l : (l as { name?: unknown }).name))
      .filter((n): n is string => typeof n === 'string'),
    draft: o['draft'] === true,
    updatedAt: String(o['updated_at'] ?? ''),
  };
}
