import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

/**
 * Finding the Agent SDK and the Claude Code CLI at runtime.
 *
 * Both exist because a packaged extension is not an npm install. The `.vsix`
 * ships no `node_modules` (`vsce --no-dependencies`), so nothing a bare
 * specifier names is resolvable from `dist/orchestrator.js` — and the SDK's
 * specifier is deliberately opaque to TypeScript, which makes it opaque to
 * esbuild too, so it is not bundled either. Under F5 it worked only because
 * the *workspace* had a `node_modules`; installed, it failed outright.
 */

/** Where the build stages the SDK inside the bundle's own directory. */
export const VENDOR_RELATIVE = join('vendor', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');

/** Overrides, for a developer pointing at a checkout or an unusual install. */
export const SDK_PATH_ENV = 'AGENTFLOW_SDK_PATH';
export const CLI_PATH_ENV = 'AGENTFLOW_CLAUDE_PATH';

export interface ResolveOptions {
  /** Directory to resolve the vendored copy against. Defaults to this module's. */
  from?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

/**
 * The specifier to hand a dynamic `import()`.
 *
 * A vendored copy wins, as a **file URL**: the SDK is ESM-only and resolving it
 * by absolute path is the only thing that works with no `node_modules` in
 * scope. Falling back to the bare specifier keeps a plain `npm install`
 * checkout — and `agent-runtime` used as a library — working unchanged.
 */
export function sdkSpecifier(opts: ResolveOptions = {}): string {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;

  const override = env[SDK_PATH_ENV];
  if (override) return pathToFileURL(override).href;

  for (const dir of [opts.from ?? __dirname, join(opts.from ?? __dirname, '..')]) {
    const candidate = join(dir, VENDOR_RELATIVE);
    if (exists(candidate)) return pathToFileURL(candidate).href;
  }
  return '@anthropic-ai/claude-agent-sdk';
}

/**
 * Where the `claude` binary is, or undefined to let the SDK find its own.
 *
 * The SDK otherwise resolves a **platform-specific native CLI** from its
 * `optionalDependencies` — 192 MB for one architecture, which would both bloat
 * the `.vsix` beyond reason and make it platform-specific. A developer running
 * this is signed into Claude Code by definition, so their own CLI is the one to
 * drive; the SDK's own error message names this as the supported alternative.
 *
 * Returning undefined is not a failure: a checkout that installed the optional
 * dependency should use it, and the SDK's error is clear when neither exists.
 */
export function claudeCliPath(opts: ResolveOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? isExecutable;

  const override = env[CLI_PATH_ENV];
  if (override) return exists(override) ? override : undefined;

  const names = process.platform === 'win32'
    ? ['claude.cmd', 'claude.exe', 'claude']
    : ['claude'];

  for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// --- authentication --------------------------------------------------------

export type AuthState = 'signed_in' | 'signed_out' | 'unknown';

export interface AuthStatus {
  state: AuthState;
  /** What to tell the human. Empty when signed in. */
  detail: string;
}

/** Just enough of `claude auth status --json` to know whether to proceed. */
interface RawAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
}

export type Exec = (cli: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;

/**
 * Whether the CLI is signed in (§5.3's "integration auth valid").
 *
 * This exists because an expired session otherwise surfaces three steps later
 * as `harvest failed: Claude Code returned an error result: Failed to
 * authenticate` — which reads like a problem with the run, and is not.
 *
 * `unknown` deliberately does **not** block. An older CLI without `auth
 * status`, or a spawn that times out, is not evidence of being signed out, and
 * refusing to start on a check that could not run would break a working setup
 * to guard against a broken one. A definite `loggedIn: false` blocks.
 */
export async function claudeAuthStatus(cli: string, exec: Exec = runCli): Promise<AuthStatus> {
  let stdout: string;
  try {
    ({ stdout } = await exec(cli, ['auth', 'status', '--json']));
  } catch (err) {
    return { state: 'unknown', detail: err instanceof Error ? err.message : String(err) };
  }

  const start = stdout.indexOf('{');
  if (start < 0) return { state: 'unknown', detail: 'auth status returned no JSON' };

  let raw: RawAuthStatus;
  try {
    raw = JSON.parse(stdout.slice(start)) as RawAuthStatus;
  } catch {
    return { state: 'unknown', detail: 'auth status returned unparseable JSON' };
  }

  if (raw.loggedIn === true) return { state: 'signed_in', detail: '' };
  if (raw.loggedIn === false) {
    return {
      state: 'signed_out',
      detail: `the Claude Code CLI is not signed in (authMethod: ${raw.authMethod ?? 'none'}). ` +
        'Run `claude auth login` in a terminal, then start the run again.',
    };
  }
  return { state: 'unknown', detail: 'auth status did not report loggedIn' };
}

const execFileAsync = promisify(execFile);

/** Bounded: a hung CLI must not hold a run in preflight indefinitely. */
async function runCli(cli: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await execFileAsync(cli, args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
    return { stdout, exitCode: 0 };
  } catch (err) {
    // A non-zero exit is the answer here, not an error: the CLI exits 1 when
    // it is signed out and still prints the JSON that says so.
    const e = err as { stdout?: string; code?: number };
    if (typeof e.stdout === 'string' && e.stdout.includes('{')) {
      return { stdout: e.stdout, exitCode: e.code ?? 1 };
    }
    throw err;
  }
}
