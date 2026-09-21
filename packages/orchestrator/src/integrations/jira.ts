import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Jira read surface (§10.2), on `fetch` and nothing else — same reasoning
 * as the GitHub client (D58): the packaged `.vsix` ships no `node_modules`, so
 * a dependency would have to be vendored beside the bundle.
 *
 * Read-only. §D.3's `writePolicy` defaults to `batch_at_ship` and nothing
 * writes during exploration: "an agent that comments on tickets while it is
 * thinking is the fastest way to get the tool banned by the team."
 */

export interface JiraConfig {
  host: string;
  email: string;
  token: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  url: string;
  status: string;
  issueType: string;
  priority: string | undefined;
  labels: string[];
  assignee: string | undefined;
  updatedAt: string;
}

export class JiraError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'JiraError';
  }
}

/** See `DEFAULT_TIMEOUT_MS` in the GitHub client: a hang is worse than a failure. */
export const JIRA_TIMEOUT_MS = 15_000;

export type JiraFetcher = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/** Unresolved work assigned to whoever the token belongs to. */
export const MY_OPEN_ISSUES_JQL =
  'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';

export class JiraClient {
  constructor(
    private readonly config: JiraConfig,
    private readonly fetcher: JiraFetcher = (url, init) => fetch(url, init),
  ) {}

  /** Issues matching a JQL query. Capped — §6.4: 500 results is a broken query. */
  async search(jql = MY_OPEN_ISSUES_JQL, limit = 50): Promise<JiraIssue[]> {
    const host = this.config.host.replace(/\/+$/, '');
    const fields = 'summary,status,issuetype,priority,labels,assignee,updated';
    const url =
      `${host}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
      `&maxResults=${Math.min(limit, 100)}&fields=${fields}`;

    const body = await this.get<{ issues?: unknown[] }>(url);
    return (body.issues ?? []).map((raw) => this.toIssue(raw, host));
  }

  /** Whether the credentials work, for a setup check that is not a guess. */
  async whoAmI(): Promise<string> {
    const host = this.config.host.replace(/\/+$/, '');
    const me = await this.get<{ displayName?: string; emailAddress?: string }>(
      `${host}/rest/api/3/myself`,
    );
    return me.displayName ?? me.emailAddress ?? 'unknown';
  }

  private async get<T>(url: string): Promise<T> {
    // Basic with an API token is what Atlassian Cloud takes for a PAT; the
    // header is built here rather than stored so the token is in one place.
    const basic = Buffer.from(`${this.config.email}:${this.config.token}`).toString('base64');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), JIRA_TIMEOUT_MS);

    let res: Awaited<ReturnType<JiraFetcher>>;
    try {
      res = await this.fetcher(url, {
        headers: {
          accept: 'application/json',
          authorization: `Basic ${basic}`,
          'user-agent': 'agentflow',
        },
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) {
        throw new JiraError(0, `Jira did not respond within ${JIRA_TIMEOUT_MS / 1000}s.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new JiraError(res.status, describe(res.status, detail));
    }
    return (await res.json()) as T;
  }

  private toIssue(raw: unknown, host: string): JiraIssue {
    const o = (raw ?? {}) as Record<string, unknown>;
    const f = (o['fields'] ?? {}) as Record<string, unknown>;
    const named = (v: unknown): string | undefined => {
      const n = (v as { name?: unknown; displayName?: unknown } | null)?.name
        ?? (v as { displayName?: unknown } | null)?.displayName;
      return typeof n === 'string' ? n : undefined;
    };
    const key = String(o['key'] ?? '');
    return {
      key,
      summary: String(f['summary'] ?? ''),
      url: `${host}/browse/${key}`,
      status: named(f['status']) ?? 'unknown',
      issueType: named(f['issuetype']) ?? 'unknown',
      priority: named(f['priority']),
      labels: Array.isArray(f['labels']) ? f['labels'].filter((l): l is string => typeof l === 'string') : [],
      assignee: named(f['assignee']),
      updatedAt: String(f['updated'] ?? ''),
    };
  }
}

function describe(status: number, detail: string): string {
  if (status === 401) return 'Jira rejected the credentials (401). Check the email and API token.';
  if (status === 403) return 'Jira refused the request (403). The account may lack access to the project.';
  if (status === 404) {
    return 'Jira returned 404 — usually the wrong host, or an instance on the older API.';
  }
  if (status === 400) {
    // A bad JQL is the common 400 and Jira says which part, so pass it on.
    return `Jira rejected the query (400)${detail ? `: ${detail.slice(0, 200)}` : ''}`;
  }
  return `Jira returned ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
}

export const JIRA_ENV = {
  host: ['AGENTFLOW_JIRA_HOST', 'JIRA_HOST'],
  email: ['AGENTFLOW_JIRA_EMAIL', 'JIRA_EMAIL'],
  token: ['AGENTFLOW_JIRA_TOKEN', 'JIRA_API_TOKEN'],
} as const;

export interface ResolveJiraOptions {
  env?: NodeJS.ProcessEnv;
  /** From the extension's `SecretStorage`; the daemon has no access to it. */
  stored?: {
    host?: string | undefined;
    email?: string | undefined;
    token?: string | undefined;
  } | undefined;
  agentflowDir?: string;
}

/**
 * Jira connection settings, or undefined if this workspace has none.
 *
 * The host is the one piece that belongs in the repo — it is the same for
 * everyone on the team — so `.agentflow/config.json` can supply it while the
 * credentials stay per-user. Credentials are never read from the repo.
 */
export function resolveJiraConfig(opts: ResolveJiraOptions = {}): JiraConfig | undefined {
  const env = opts.env ?? process.env;
  const pick = (names: readonly string[]) => names.map((n) => env[n]).find(Boolean);

  const host = opts.stored?.host ?? pick(JIRA_ENV.host) ?? hostFromConfig(opts.agentflowDir);
  const email = opts.stored?.email ?? pick(JIRA_ENV.email);
  const token = opts.stored?.token ?? pick(JIRA_ENV.token);

  if (!host || !email || !token) return undefined;
  return { host, email, token };
}

export function jiraSetupHint(): string {
  return (
    'Jira is not configured. Set the host in .agentflow/config.json ' +
    '(integrations.jira.host) or $AGENTFLOW_JIRA_HOST, and supply credentials ' +
    'with the "AgentFlow: Set Jira Credentials" command, or ' +
    '$AGENTFLOW_JIRA_EMAIL and $AGENTFLOW_JIRA_TOKEN. ' +
    'The token is an Atlassian API token, read-only use.'
  );
}

function hostFromConfig(agentflowDir: string | undefined): string | undefined {
  if (!agentflowDir) return undefined;
  const path = join(agentflowDir, 'config.json');
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      integrations?: { jira?: { host?: unknown } };
    };
    const host = raw.integrations?.jira?.host;
    return typeof host === 'string' ? host : undefined;
  } catch {
    // A malformed config should not take the inbox down with it.
    return undefined;
  }
}
