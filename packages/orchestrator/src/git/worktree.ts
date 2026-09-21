import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
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

export interface RebaseResult {
  ok: boolean;
  /** Where the branch ended up. Unchanged from before the attempt on failure. */
  head: string;
  ontoSha: string;
  /** Files git could not merge. Empty when a rebase failed for another reason. */
  conflicts: string[];
  /** Present on failure: what git said, first line. */
  reason?: string;
  /** True when the branch was already on top of the base and nothing moved. */
  alreadyCurrent: boolean;
}

export interface CommitSummary {
  sha: string;
  subject: string;
}

export interface CreateWorktreeInput {
  ticketKey: string;
  baseRef: string;
  /** Defaults to `agentflow/<ticketKey>`. */
  branch?: string;
  /**
   * Repo-root entries to symlink into the new tree instead of recreating
   * (§12.6). A fresh worktree has no `node_modules`, so every gate in it fails
   * with a module-resolution error that looks like a code problem and is not.
   * Sharing is safe for install output; never share source or config.
   */
  share?: readonly string[];
}

/** What a JS/TS repo needs to run a gate at all. */
export const DEFAULT_SHARED_PATHS = ['node_modules'] as const;

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

    for (const entry of input.share ?? DEFAULT_SHARED_PATHS) {
      this.share(path, entry);
    }

    return { path, branch, baseRef: input.baseRef, baseSha, headSha: await this.head(path) };
  }

  /**
   * Symlink one repo-root entry into a worktree. Silently skipped when the
   * source is missing or the target already exists — a repo with no
   * `node_modules` is a valid repo, not an error.
   */
  private share(worktreePath: string, entry: string): void {
    const source = join(this.repoRoot, entry);
    const target = join(worktreePath, entry);
    if (!existsSync(source) || existsSync(target)) return;
    try {
      symlinkSync(source, target, 'dir');
    } catch {
      // A failed link costs a slower gate, never a failed run.
    }
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

  /**
   * Files changed against the run's base. Shared entries (§12.6) are excluded:
   * a symlinked `node_modules` is infrastructure, not something the run did,
   * and letting it reach the review surface is noise at best.
   */
  async changedFiles(
    worktreePath: string,
    baseSha: string,
    shared: readonly string[] = DEFAULT_SHARED_PATHS,
  ): Promise<{ path: string; op: 'create' | 'modify' | 'delete' }[]> {
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
    const all = [...tracked, ...news.filter((f) => !seen.has(f.path))];
    return all.filter((f) => !shared.some((s) => f.path === s || f.path.startsWith(`${s}/`)));
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
   * A worktree at a pull request's head (§7.2 preflight).
   *
   * `refs/pull/N/head` is fetched into a local ref first: a PR branch often
   * lives on a fork this remote cannot see, and the pull ref is the only
   * handle that always exists. Detached rather than on a branch, because the
   * review must not be able to commit — it reads.
   *
   * The merge base, not the base tip, is what the diff is against: a PR whose
   * target moved on since it was opened would otherwise show every unrelated
   * commit as part of the change.
   */
  async createFromPullRequest(input: {
    number: number;
    baseRef: string;
    remote?: string;
  }): Promise<WorktreeInfo & { mergeBase: string }> {
    const remote = input.remote ?? 'origin';
    const key = `PR-${input.number}`;
    const localRef = `refs/agentflow/pr/${input.number}`;

    await git(this.repoRoot, ['fetch', '--force', remote, `pull/${input.number}/head:${localRef}`]);
    const headSha = await gitLine(this.repoRoot, ['rev-parse', localRef]);
    const baseSha = await this.resolveBase(input.baseRef);
    const mergeBase = await gitLine(this.repoRoot, ['merge-base', baseSha, headSha]);

    const path = this.pathFor(key);
    if (existsSync(path)) await this.remove(key, true);
    mkdirSync(dirname(path), { recursive: true });
    await git(this.repoRoot, ['worktree', 'add', '--detach', path, headSha]);
    for (const entry of DEFAULT_SHARED_PATHS) this.share(path, entry);

    return {
      path,
      branch: `(detached at ${headSha.slice(0, 7)})`,
      baseRef: input.baseRef,
      baseSha: mergeBase,
      headSha,
      mergeBase,
    };
  }

  /**
   * Rebase the run's branch onto its base (§5.8 step 1).
   *
   * A textual conflict aborts and reports, and auto-resolution is never
   * attempted (§13.3): a machine-resolved conflict is a silent semantic change
   * in code a human already approved at G3, which is the worst possible place
   * to guess. The abort matters as much as the report — leaving the tree
   * mid-rebase would strand the run in a state nothing else knows how to read.
   */
  async rebase(worktreePath: string, ontoRef: string): Promise<RebaseResult> {
    const ontoSha = await this.resolveBase(ontoRef);
    const before = await this.head(worktreePath);

    // Rebasing a dirty tree fails halfway and leaves a mess. The caller
    // commits per task, so anything uncommitted here is unexplained.
    if (await this.isDirty(worktreePath)) {
      return {
        ok: false, head: before, ontoSha, conflicts: [], alreadyCurrent: false,
        reason: 'worktree has uncommitted changes; nothing should be uncommitted by ship',
      };
    }

    // Already on top of the base: the rebase is a no-op, worth reporting so the
    // caller can say "nothing to rebase" rather than implying work happened.
    const ancestor = await git(worktreePath, ['merge-base', '--is-ancestor', ontoSha, 'HEAD'], true);
    const alreadyCurrent = ancestor.exitCode === 0;

    const result = await git(worktreePath, ['rebase', ontoSha], true);
    if (result.exitCode === 0) {
      return { ok: true, head: await this.head(worktreePath), ontoSha, conflicts: [], alreadyCurrent };
    }

    const conflicts = (await git(worktreePath, ['diff', '--name-only', '--diff-filter=U'], true))
      .stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    await git(worktreePath, ['rebase', '--abort'], true);

    const said = `${result.stderr}\n${result.stdout}`.trim().split('\n').map((l) => l.trim());
    return {
      ok: false,
      head: await this.head(worktreePath),
      ontoSha,
      conflicts,
      alreadyCurrent,
      reason: said.find((l) => /CONFLICT|could not apply/i.test(l)) ?? said[0] ?? 'rebase failed',
    };
  }

  /** Commits this branch has that the base does not — the PR's commit list. */
  async commitsSince(worktreePath: string, baseSha: string): Promise<CommitSummary[]> {
    const { stdout } = await git(
      worktreePath,
      ['log', '--format=%H%x00%s', `${baseSha}..HEAD`],
      true,
    );
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const [sha = '', subject = ''] = line.split('\u0000');
      return { sha, subject };
    });
  }

  /**
   * The unified diff against the base — what a reviewer actually reads.
   *
   * Bounded, and honest about it. An unbounded diff would silently fill the
   * reviewer's context and push the spec and plan out of it, producing a review
   * of the last few files that reads like a review of the change.
   */
  async diff(
    worktreePath: string,
    baseSha: string,
    maxBytes = 240_000,
  ): Promise<{ patch: string; truncated: boolean }> {
    const { stdout } = await git(
      worktreePath,
      ['diff', '--no-color', '--unified=3', `${baseSha}..HEAD`],
      true,
    );
    if (stdout.length <= maxBytes) return { patch: stdout, truncated: false };
    return { patch: stdout.slice(0, maxBytes), truncated: true };
  }

  /** `git diff --stat` against the base, for the handoff card. */
  async diffStat(worktreePath: string, baseSha: string): Promise<string> {
    const { stdout } = await git(worktreePath, ['diff', '--stat', `${baseSha}..HEAD`], true);
    return stdout.trimEnd();
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
