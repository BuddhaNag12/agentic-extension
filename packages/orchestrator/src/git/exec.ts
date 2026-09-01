import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${exitCode}): ${stderr.trim().split('\n')[0] ?? ''}`);
    this.name = 'GitError';
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs git with a fixed environment. Every mutating git operation in the system
 * goes through the orchestrator (§8.4) — agents get read-only git via MCP — so
 * this is the single place a repository is modified.
 */
export async function git(cwd: string, args: string[], allowFail = false): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        // Keep hooks and interactive prompts out of automated runs: a pre-commit
        // hook that opens an editor would hang a worker forever.
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stderr?: string; stdout?: string };
    if (allowFail) return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    throw new GitError(args, e.code ?? null, e.stderr ?? String(err));
  }
}

export async function gitLine(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).stdout.trim();
}
