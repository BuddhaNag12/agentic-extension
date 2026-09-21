import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseRemote, type RepoCoordinates } from './github.js';

/**
 * Where the GitHub token comes from, and which repo we are looking at.
 *
 * §7.7 asks for "a GitHub App or a fine-grained PAT in `SecretStorage`,
 * scoped to the repos in config" and for the narrowest scopes that work. The
 * order below puts the *explicit* sources first so a developer can always
 * override what the machine guessed.
 */

export const TOKEN_ENV_VARS = ['AGENTFLOW_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as const;

/**
 * The only scope this needs.
 *
 * Read-only, because nothing in the review path writes (§7.5 never
 * auto-posts). Documented here rather than in a README because the thing a
 * security review asks is "what does it request", and the answer should live
 * next to the code that requests it.
 */
export const REQUIRED_SCOPES = 'repo:status, public_repo — or a fine-grained PAT with Pull requests: Read';

export interface TokenSource {
  token: string;
  /** Which of the sources below supplied it, for the "where did this come from" question. */
  from: string;
}

export interface ResolveTokenOptions {
  env?: NodeJS.ProcessEnv;
  /** Supplied by the extension host from `SecretStorage`; the daemon has none. */
  stored?: string | undefined;
  exec?: (cmd: string, args: string[]) => Promise<string>;
}

/**
 * Resolve a token, or explain what to do about its absence.
 *
 * Returns undefined rather than throwing: not having GitHub configured is a
 * normal state for a workspace that only runs the deliver pipeline, and the
 * caller decides whether that is a problem yet.
 */
export async function resolveGitHubToken(
  opts: ResolveTokenOptions = {},
): Promise<TokenSource | undefined> {
  const env = opts.env ?? process.env;

  if (opts.stored) return { token: opts.stored, from: 'VS Code SecretStorage' };

  for (const name of TOKEN_ENV_VARS) {
    const value = env[name];
    if (value) return { token: value, from: `$${name}` };
  }

  // Last, because it is the least explicit — but a developer with `gh`
  // already signed in should not have to mint a second token to use this.
  const exec = opts.exec ?? runCommand;
  try {
    const out = (await exec('gh', ['auth', 'token'])).trim();
    if (out) return { token: out, from: 'the gh CLI' };
  } catch {
    // Not installed, or not signed in. Neither is an error here.
  }
  return undefined;
}

/** What to tell a human who has no token configured. */
export function tokenSetupHint(): string {
  return (
    'No GitHub token found. Set one of ' +
    TOKEN_ENV_VARS.map((v) => `$${v}`).join(', ') +
    ', sign in with `gh auth login`, or store one with the ' +
    '"AgentFlow: Set GitHub Token" command. ' +
    `Scopes needed: ${REQUIRED_SCOPES}.`
  );
}

/**
 * Which repository this workspace pushes to.
 *
 * `origin` first, then any other remote — a fork workflow often has `origin`
 * pointing at the fork and `upstream` at the repo whose PRs you review, so
 * refusing to look past `origin` would hide exactly the list that matters.
 */
export async function detectRepo(
  root: string,
  exec: (cmd: string, args: string[]) => Promise<string> = runCommand,
): Promise<RepoCoordinates | undefined> {
  let raw: string;
  try {
    raw = await exec('git', ['-C', root, 'remote', '-v']);
  } catch {
    return undefined;
  }

  const remotes = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line.trim());
    if (m) remotes.set(m[1]!, m[2]!);
  }

  for (const name of ['origin', ...remotes.keys()]) {
    const url = remotes.get(name);
    const parsed = url ? parseRemote(url) : undefined;
    if (parsed) return parsed;
  }
  return undefined;
}

const execFileAsync = promisify(execFile);

async function runCommand(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 });
  return stdout;
}
