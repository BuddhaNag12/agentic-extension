import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Which repository a run targets (§1376, Appendix B `repos`).
 *
 * Until now a run always targeted the first workspace folder: `repo.path` was
 * `paths.root` and nothing read `RepoRef.id`, so a ticket whose changes live
 * in another repo could only be worked by opening that repo instead.
 *
 * This is the one-repo-per-run answer to §1376, not the cross-repo v2: a run
 * still has exactly one repo, it just no longer has to be the workspace. The
 * run's *state* stays in the current workspace's `.agentflow/` — only git
 * moves — so a registered repo may sit anywhere, which is the point. Sibling
 * clones are the normal layout, and a monorepo subdirectory is not a separate
 * git repository at all.
 */

export interface TicketRouting {
  /** Jira project keys: `FWERP` matches `FWERP-3838`. */
  projects?: string[];
  /** Any one of these labels on the ticket routes it here. */
  labels?: string[];
}

export interface RepoEntry {
  id: string;
  /** Absolute, resolved from the workspace root when the config is relative. */
  path: string;
  /** Branch name, not a ref: `main`, which becomes `origin/main`. */
  baseBranch: string;
  tickets?: TicketRouting;
}

export interface RepoRegistry {
  repos: RepoEntry[];
  /** The entry used when nothing routes — always the workspace itself. */
  fallback: RepoEntry;
  /** Misconfigurations worth telling someone about, never thrown. */
  problems: string[];
}

export const DEFAULT_REPO_ID = 'default';

/** `FWERP-3838` → `FWERP`. Undefined for anything not shaped like a key. */
export function projectKeyOf(ticketKey: string): string | undefined {
  const m = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(ticketKey.trim());
  return m ? m[1]!.toUpperCase() : undefined;
}

/**
 * Read `.agentflow/config.json`'s `repos`.
 *
 * Never throws and never returns empty: a broken registry falls back to the
 * workspace, because the failure mode of a config typo should be "runs target
 * the repo they always did", not "no runs can start".
 */
export function loadRepoRegistry(workspaceRoot: string, agentflowDir: string): RepoRegistry {
  const fallback: RepoEntry = {
    id: DEFAULT_REPO_ID,
    path: resolve(workspaceRoot),
    baseBranch: 'main',
  };
  const problems: string[] = [];
  const path = join(agentflowDir, 'config.json');
  if (!existsSync(path)) return { repos: [fallback], fallback, problems };

  let raw: { repos?: unknown };
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as { repos?: unknown };
  } catch {
    problems.push('.agentflow/config.json is not valid JSON; using the workspace repository.');
    return { repos: [fallback], fallback, problems };
  }

  if (!Array.isArray(raw.repos)) return { repos: [fallback], fallback, problems };

  const repos: RepoEntry[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.repos.entries()) {
    const o = (entry ?? {}) as Record<string, unknown>;
    const rawPath = typeof o['path'] === 'string' ? o['path'] : undefined;
    if (!rawPath) {
      problems.push(`repos[${i}] has no path and was ignored.`);
      continue;
    }
    const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspaceRoot, rawPath);
    const id = typeof o['id'] === 'string' && o['id'].trim()
      ? o['id'].trim()
      : abs === resolve(workspaceRoot) ? DEFAULT_REPO_ID : abs.split('/').pop()!;

    if (seen.has(id)) {
      problems.push(`repos[${i}] repeats the id "${id}" and was ignored.`);
      continue;
    }
    // Reported, not rejected: a teammate's checkout may legitimately be
    // missing on this machine, and that must not stop the other repos working.
    if (!existsSync(abs)) problems.push(`"${id}" points at ${abs}, which does not exist.`);
    else if (!existsSync(join(abs, '.git'))) problems.push(`"${id}" (${abs}) is not a git repository.`);

    seen.add(id);
    repos.push({
      id,
      path: abs,
      baseBranch: typeof o['baseBranch'] === 'string' && o['baseBranch'] ? o['baseBranch'] : 'main',
      ...(routingOf(o['tickets']) ? { tickets: routingOf(o['tickets'])! } : {}),
    });
  }

  if (repos.length === 0) return { repos: [fallback], fallback, problems };
  // The workspace stays reachable even when the config never mentions it,
  // or a ticket that routes nowhere would have no repo to fall back to.
  const ws = repos.find((r) => r.path === resolve(workspaceRoot));
  return { repos, fallback: ws ?? fallback, problems };
}

function routingOf(v: unknown): TicketRouting | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const list = (k: string) =>
    Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const projects = list('projects').map((p) => p.toUpperCase());
  const labels = list('labels');
  if (!projects.length && !labels.length) return undefined;
  return {
    ...(projects.length ? { projects } : {}),
    ...(labels.length ? { labels } : {}),
  };
}

export interface RouteInput {
  ticketKey: string;
  labels?: readonly string[];
  /** A repo the human named explicitly; it always wins. */
  repoId?: string | undefined;
}

export interface RouteResult {
  repo: RepoEntry;
  /** How it was chosen, for the log — guessing silently is how you end up
   *  branching the wrong repository and not finding out until ship. */
  why: 'explicit' | 'project' | 'label' | 'fallback';
  /** More than one entry claimed this ticket; the first won. */
  ambiguous?: string[];
}

/**
 * Pick the repo for a ticket.
 *
 * Project key before label: a key is structural and a label is something
 * anyone can add to a ticket, so the more deliberate signal wins.
 */
export function routeTicket(registry: RepoRegistry, input: RouteInput): RouteResult {
  if (input.repoId) {
    const named = registry.repos.find((r) => r.id === input.repoId);
    if (named) return { repo: named, why: 'explicit' };
  }

  const project = projectKeyOf(input.ticketKey);
  const byProject = project
    ? registry.repos.filter((r) => r.tickets?.projects?.includes(project))
    : [];
  if (byProject.length) return matched(byProject, 'project');

  const labels = new Set(input.labels ?? []);
  const byLabel = labels.size
    ? registry.repos.filter((r) => r.tickets?.labels?.some((l) => labels.has(l)))
    : [];
  if (byLabel.length) return matched(byLabel, 'label');

  return { repo: registry.fallback, why: 'fallback' };
}

function matched(hits: RepoEntry[], why: 'project' | 'label'): RouteResult {
  return hits.length === 1
    ? { repo: hits[0]!, why }
    : { repo: hits[0]!, why, ambiguous: hits.map((r) => r.id) };
}
