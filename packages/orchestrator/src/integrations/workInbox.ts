import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GitHubClient, type RepoCoordinates } from './github.js';
import { JiraClient, type StatusCategory } from './jira.js';

/**
 * The Work Inbox poller (§6.1, §6.4): the tickets assigned to you and the
 * pull requests waiting on your review, in one list, kept fresh in the
 * background.
 *
 * Three properties from §6.4 are the whole point, and each is a way this kind
 * of thing normally goes wrong:
 *
 * - **Cache first.** The list renders instantly from disk on activation and
 *   refreshes behind it. An inbox that is empty for two seconds every morning
 *   is one you stop trusting before you stop opening.
 * - **Offline shows the cache, stale-marked.** Never an empty list — "you have
 *   no work" and "I could not ask" are different answers.
 * - **Per-source intervals with jitter**, so two sources do not stampede
 *   together on every tick.
 */

export type WorkSource = 'jira' | 'github';

export interface WorkItem {
  /** Stable across refreshes, so the UI can diff rather than redraw. */
  id: string;
  source: WorkSource;
  /** `PAY-1423`, or `#42`. */
  key: string;
  title: string;
  url: string;
  status: string;
  /** Jira's status category, for the inbox tabs. Absent on a GitHub item. */
  category?: StatusCategory | undefined;
  /** The ticket body, so starting a run from here has something to harvest. */
  description?: string | undefined;
  labels: string[];
  updatedAt: string;
  /** Jira: the issue type. GitHub: the author. */
  detail: string | undefined;
  draft: boolean;
}

export interface SourceState {
  items: WorkItem[];
  fetchedAt: number | undefined;
  /** Why the last attempt failed, if it did. The items above may still be good. */
  problem: string | undefined;
}

export interface InboxSnapshot {
  jira: SourceState;
  github: SourceState;
  /** True when nothing has been fetched successfully this session. */
  stale: boolean;
}

/** §6.4's defaults: tickets move more slowly than review queues. */
export const JIRA_INTERVAL_MS = 300_000;
export const GITHUB_INTERVAL_MS = 120_000;
/** §6.4: a query returning hundreds is a broken query, and paging is not the fix. */
export const MAX_ITEMS = 200;

export interface InboxProviders {
  jira?: () => Promise<{ client: JiraClient } | { problem: string }>;
  github?: () => Promise<{ client: GitHubClient; repo: RepoCoordinates } | { problem: string }>;
}

/**
 * Which pull requests count as "your work" (§6.1).
 *
 * This was hardcoded to `review-requested`, which is the one filter that can
 * never match a PR you opened yourself — so on any repo where you are the
 * author, the list was permanently empty and looked broken.
 */
export type PrScope = 'involves' | 'review-requested' | 'authored' | 'all';

export interface WorkInboxOptions {
  cacheFile: string;
  /** Defaults to `involves`: opened by you, or waiting on you. */
  prScope?: PrScope;
  providers: InboxProviders;
  jiraIntervalMs?: number;
  githubIntervalMs?: number;
  /** Injected in tests; real jitter would make them flaky. */
  jitter?: (base: number) => number;
}

export class WorkInbox extends EventEmitter {
  private state: InboxSnapshot = {
    jira: empty(), github: empty(), stale: true,
  };
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(private readonly opts: WorkInboxOptions) {
    super();
    this.setMaxListeners(32);
    this.state = { ...this.readCache(), stale: true };
  }

  snapshot(): InboxSnapshot {
    return this.state;
  }

  /** Begin polling. Both sources refresh immediately, then on their own clock. */
  start(): void {
    if (this.running) return;
    this.running = true;

    const jitter = this.opts.jitter ?? ((base) => base * (0.85 + Math.random() * 0.3));
    const schedule = (fn: () => Promise<void>, base: number) => {
      const tick = () => {
        void fn().finally(() => {
          if (!this.running) return;
          const t = setTimeout(tick, jitter(base));
          // Unref'd: a poll timer must never be the reason the daemon stays up.
          t.unref?.();
          this.timers.push(t);
        });
      };
      tick();
    };

    schedule(() => this.refreshJira(), this.opts.jiraIntervalMs ?? JIRA_INTERVAL_MS);
    schedule(() => this.refreshGitHub(), this.opts.githubIntervalMs ?? GITHUB_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Force both sources now — the "refresh" button. */
  async refreshNow(): Promise<InboxSnapshot> {
    await Promise.all([this.refreshJira(), this.refreshGitHub()]);
    return this.state;
  }

  /** Change the scope and drop the cached list, which was built under the old one. */
  setPrScope(scope: PrScope): void {
    if ((this.opts.prScope ?? 'involves') === scope) return;
    this.opts.prScope = scope;
    this.state = { ...this.state, github: empty(), stale: true };
  }

  private async refreshJira(): Promise<void> {
    const provider = this.opts.providers.jira;
    if (!provider) return;
    await this.refresh('jira', async () => {
      const r = await provider();
      if ('problem' in r) throw new Error(r.problem);
      const issues = await r.client.search();
      return issues.slice(0, MAX_ITEMS).map((i): WorkItem => ({
        id: `jira:${i.key}`,
        source: 'jira',
        key: i.key,
        title: i.summary,
        url: i.url,
        status: i.status,
        category: i.statusCategory,
        description: i.description,
        labels: i.labels,
        updatedAt: i.updatedAt,
        detail: i.issueType,
        draft: false,
      }));
    });
  }

  private async refreshGitHub(): Promise<void> {
    const provider = this.opts.providers.github;
    if (!provider) return;
    await this.refresh('github', async () => {
      const r = await provider();
      if ('problem' in r) throw new Error(r.problem);
      // The PRs actually waiting on this person, which is what "tagged" means
      // in a review queue — not every open PR in the repo.
      const scope = this.opts.prScope ?? 'involves';
      const prs = await r.client.listPullRequests({
        repo: r.repo,
        state: 'open',
        ...(scope === 'review-requested' ? { reviewRequested: true } : {}),
        ...(scope === 'involves' ? { involves: true } : {}),
        ...(scope === 'authored' ? { authored: true } : {}),
        limit: Math.min(MAX_ITEMS, 100),
      });
      return prs.map((p): WorkItem => ({
        id: `github:${p.number}`,
        source: 'github',
        key: `#${p.number}`,
        title: p.title,
        url: p.url,
        status: p.draft ? 'draft' : 'open',
        labels: p.labels,
        updatedAt: p.updatedAt,
        detail: p.author,
        draft: p.draft,
      }));
    });
  }

  private async refresh(source: WorkSource, load: () => Promise<WorkItem[]>): Promise<void> {
    try {
      const items = await load();
      this.state = {
        ...this.state,
        [source]: { items, fetchedAt: Date.now(), problem: undefined },
        stale: false,
      };
      this.writeCache();
    } catch (err) {
      // The previous items stay. An unreachable source means "I could not
      // ask", and replacing the list with nothing says "you have no work",
      // which is a different and wrong answer.
      this.state = {
        ...this.state,
        [source]: {
          ...this.state[source],
          problem: err instanceof Error ? err.message : String(err),
        },
      };
    }
    this.emit('changed', this.state);
  }

  private readCache(): InboxSnapshot {
    try {
      if (!existsSync(this.opts.cacheFile)) return { jira: empty(), github: empty(), stale: true };
      const raw = JSON.parse(readFileSync(this.opts.cacheFile, 'utf8')) as Partial<InboxSnapshot>;
      return {
        jira: { ...empty(), ...raw.jira },
        github: { ...empty(), ...raw.github },
        stale: true,
      };
    } catch {
      // A corrupt cache is not worth a failed start; it will be rewritten.
      return { jira: empty(), github: empty(), stale: true };
    }
  }

  private writeCache(): void {
    try {
      mkdirSync(dirname(this.opts.cacheFile), { recursive: true });
      writeFileSync(this.opts.cacheFile, JSON.stringify(this.state, null, 2), 'utf8');
    } catch { /* the cache is an optimization, never a requirement */ }
  }
}

function empty(): SourceState {
  return { items: [], fetchedAt: undefined, problem: undefined };
}

export function inboxCachePath(stateDir: string): string {
  return join(stateDir, 'cache', 'inbox.json');
}

/** Both sources merged, most recently updated first — §6.1's "one list". */
export function mergedItems(snapshot: InboxSnapshot): WorkItem[] {
  return [...snapshot.jira.items, ...snapshot.github.items]
    .sort((a, b) => Date.parse(b.updatedAt || '0') - Date.parse(a.updatedAt || '0'));
}
