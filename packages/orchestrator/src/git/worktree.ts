import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { git, gitLine } from './exec.js';

/**
 * One git worktree per run (§4.1). Real worktrees rather than a virtual FS:
 * builds, tests and language servers all need a real tree, isolation is total,
 * rollback is `git reset`, and cleanup is `git worktree remove`.
 *
 * Worktrees live in a **sibling** directory (DECISIONS D2) — build tooling that
 * resolves paths from the repo root gets confused by nested worktrees.
 */

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
}

export interface CreateWorktreeInput {
  ticketKey: string;
  baseRef: string;
  /** Defaults to `agentflow/<ticketKey>`. */
  branch?: string;
}

export class WorktreeManager {
  constructor(
    private readonly repoRoot: string,
    /** Defaults to `<repo>-agentflow`, a sibling of the repository. */
    private readonly containerDir = `${resolve(repoRoot)}-agentflow`,
  ) {}

  pathFor(ticketKey: string): string {
    return join(this.containerDir, ticketKey);
  }

  branchFor(ticketKey: string): string {
    return `agentflow/${ticketKey}`;
  }

  async isRepo(): Promise<boolean> {
    const { stdout } = await git(this.repoRoot, ['rev-parse', '--is-inside-work-tree'], true);
    return stdout.trim() === 'true';
  }

  /**
   * Resolve a base ref to a sha. Prefers the remote-tracking ref, so a run
   * branches from what the team sees rather than from a stale local branch —
   * but an explicitly requested local ref is honoured (DECISIONS D5).
   */
  async resolveBase(baseRef: string): Promise<string> {
    const candidates = baseRef.includes('/') ? [baseRef] : [`origin/${baseRef}`, baseRef];
    for (const ref of candidates) {
      const { stdout } = await git(this.repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`], true);
      if (stdout.trim()) return stdout.trim();
    }
    throw new Error(`cannot resolve base ref "${baseRef}" (tried ${candidates.join(', ')})`);
  }

  async create(input: CreateWorktreeInput): Promise<WorktreeInfo> {
    const branch = input.branch ?? this.branchFor(input.ticketKey);
    const path = this.pathFor(input.ticketKey);
    const baseSha = await this.resolveBase(input.baseRef);

    if (existsSync(path)) {
      throw new Error(`worktree path already exists: ${path}`);
    }
    mkdirSync(dirname(path), { recursive: true });

    // Reuse an existing branch rather than failing: a run resumed after its
    // worktree was removed must be able to re-attach to its own history.
    const branchExists = await this.branchExists(branch);
    const args = branchExists
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', path, '-b', branch, baseSha];
    await git(this.repoRoot, args);

    return { path, branch, baseRef: input.baseRef, baseSha, headSha: await this.head(path) };
  }

  async branchExists(branch: string): Promise<boolean> {
    const { stdout } = await git(
      this.repoRoot, ['rev-parse', '--verify', `refs/heads/${branch}`], true,
    );
    return stdout.trim().length > 0;
  }

  async head(worktreePath: string): Promise<string> {
    return gitLine(worktreePath, ['rev-parse', 'HEAD']);
  }

  async currentBranch(worktreePath: string): Promise<string> {
    return gitLine(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async list(): Promise<{ path: string; branch: string; head: string }[]> {
    const { stdout } = await git(this.repoRoot, ['worktree', 'list', '--porcelain']);
    const out: { path: string; branch: string; head: string }[] = [];
    let current: Partial<{ path: string; branch: string; head: string }> = {};
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) current = { path: line.slice(9) };
      else if (line.startsWith('HEAD ')) current.head = line.slice(5);
      else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
      else if (line.trim() === '' && current.path) {
        out.push({ path: current.path, branch: current.branch ?? '(detached)', head: current.head ?? '' });
        current = {};
      }
    }
    if (current.path) {
      out.push({ path: current.path, branch: current.branch ?? '(detached)', head: current.head ?? '' });
    }
    return out;
  }

  /**
   * Remove a worktree. `force` also discards uncommitted work, so it is only
   * used on explicit abandonment — a run whose tree has changes the human has
   * not seen must not be silently deleted.
   */
  async remove(ticketKey: string, force = false): Promise<void> {
    const path = this.pathFor(ticketKey);
    if (!existsSync(path)) {
      await this.prune();
      return;
    }
    await git(this.repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
    await this.prune();
  }

  /** Clear metadata for worktrees whose directories are gone. */
  async prune(): Promise<void> {
    await git(this.repoRoot, ['worktree', 'prune'], true);
  }

  /** Files changed against the run's base, as `{path, op}` pairs. */
  async changedFiles(worktreePath: string, baseSha: string): Promise<{ path: string; op: 'create' | 'modify' | 'delete' }[]> {
    const { stdout } = await git(worktreePath, ['diff', '--name-status', baseSha, '--']);
    const tracked = stdout.split('\n').filter(Boolean).map((line) => {
      const [status, ...rest] = line.split('\t');
      const path = rest[rest.length - 1] ?? '';
      const op = status?.startsWith('A') ? 'create' as const
        : status?.startsWith('D') ? 'delete' as const
        : 'modify' as const;
      return { path, op };
    });

    // Untracked files are part of the change set even though diff ignores them;
    // a new file the agent has not staged still needs to reach the review.
    const { stdout: untracked } = await git(worktreePath, ['ls-files', '--others', '--exclude-standard']);
    const news = untracked.split('\n').filter(Boolean).map((path) => ({ path, op: 'create' as const }));

    const seen = new Set(tracked.map((f) => f.path));
    return [...tracked, ...news.filter((f) => !seen.has(f.path))];
  }

  async isDirty(worktreePath: string): Promise<boolean> {
    const { stdout } = await git(worktreePath, ['status', '--porcelain']);
    return stdout.trim().length > 0;
  }

  /**
   * A durable, coarse checkpoint (§11.2). `git stash create` builds a commit
   * object without touching the index or the working tree, so it is safe to
   * call mid-run; the sha is recorded in the event log.
   */
  async checkpoint(worktreePath: string): Promise<string | undefined> {
    const { stdout } = await git(worktreePath, ['stash', 'create'], true);
    return stdout.trim() || undefined;
  }

  /** Restore the tree to a checkpoint or commit. Destructive by construction. */
  async restore(worktreePath: string, sha: string): Promise<void> {
    await git(worktreePath, ['restore', '--source', sha, '--staged', '--worktree', '.']);
  }

  async commit(worktreePath: string, message: string, trailers: Record<string, string> = {}): Promise<string> {
    await git(worktreePath, ['add', '-A']);
    const body = Object.entries(trailers).map(([k, v]) => `${k}: ${v}`).join('\n');
    const full = body ? `${message}\n\n${body}` : message;
    await git(worktreePath, ['commit', '--no-verify', '-m', full]);
    return this.head(worktreePath);
  }

  /**
   * Resume guard (§13.2): a worktree that has moved out from under a run must
   * block rather than be reasoned about.
   */
  async verify(ticketKey: string, expected: { branch: string; headSha?: string }): Promise<
    { ok: true; info: { path: string; head: string } } | { ok: false; reason: string }
  > {
    const path = this.pathFor(ticketKey);
    if (!existsSync(path)) return { ok: false, reason: `worktree missing at ${path}` };

    const branch = await this.currentBranch(path);
    if (branch !== expected.branch) {
      return { ok: false, reason: `worktree is on "${branch}", expected "${expected.branch}"` };
    }
    const head = await this.head(path);
    if (expected.headSha && head !== expected.headSha) {
      return { ok: false, reason: `HEAD is ${head.slice(0, 8)}, expected ${expected.headSha.slice(0, 8)}` };
    }
    return { ok: true, info: { path, head } };
  }

  /**
   * Is this path one of ours? Compared through `realpath` because git reports
   * fully resolved paths: on macOS `/var/...` and `/private/var/...` name the
   * same directory, and a plain prefix check silently matches neither.
   */
  private isInsideContainer(candidate: string): boolean {
    const real = (p: string) => {
      try { return realpathSync(p); } catch { return resolve(p); }
    };
    const container = real(this.containerDir);
    const target = real(candidate);
    return target === container || target.startsWith(container + sep);
  }

  /** Remove the container directory entirely. Used by tests and by full GC. */
  async destroyAll(): Promise<void> {
    for (const wt of await this.list()) {
      if (this.isInsideContainer(wt.path)) {
        await git(this.repoRoot, ['worktree', 'remove', '--force', wt.path], true);
      }
    }
    await this.prune();
    rmSync(this.containerDir, { recursive: true, force: true });
  }

  get container(): string {
    return this.containerDir;
  }

  get repoName(): string {
    return basename(this.repoRoot);
  }
}
