import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeManager } from './worktree.js';
import { git } from './exec.js';

/**
 * Real git, real worktrees. These tests build an actual repository with an
 * `origin` remote so the base-ref resolution and worktree lifecycle are
 * exercised against git itself rather than a mock.
 */

let root: string;
let repo: string;
let manager: WorktreeManager;

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentflow-git-'));

  // A bare repo standing in for origin, plus a working clone.
  const origin = join(root, 'origin.git');
  mkdirSync(origin);
  run(origin, 'init', '--bare', '--initial-branch=main');

  repo = join(root, 'repo');
  mkdirSync(repo);
  run(repo, 'init', '--initial-branch=main');
  run(repo, 'config', 'user.email', 'test@example.com');
  run(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), '# base\n');
  writeFileSync(join(repo, 'src.ts'), 'export const x = 1;\n');
  run(repo, 'add', '-A');
  run(repo, 'commit', '-m', 'base commit');
  run(repo, 'remote', 'add', 'origin', origin);
  run(repo, 'push', '-u', 'origin', 'main');

  manager = new WorktreeManager(repo, join(root, 'worktrees'));
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('creating worktrees', () => {
  it('creates an isolated tree on its own branch from origin/main', async () => {
    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });

    expect(existsSync(join(info.path, 'README.md'))).toBe(true);
    expect(info.branch).toBe('agentflow/PAY-1');
    expect(await manager.currentBranch(info.path)).toBe('agentflow/PAY-1');
    expect(info.baseSha).toHaveLength(40);
  });

  it('keeps two runs completely isolated from each other', async () => {
    const a = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    const b = await manager.create({ ticketKey: 'PAY-2', baseRef: 'main' });

    writeFileSync(join(a.path, 'only-in-a.ts'), 'export const a = 1;\n');
    expect(existsSync(join(b.path, 'only-in-a.ts'))).toBe(false);
    expect(existsSync(join(repo, 'only-in-a.ts'))).toBe(false);
  });

  it('never touches the user’s working copy', async () => {
    writeFileSync(join(repo, 'my-wip.ts'), 'work in progress\n');
    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });

    // Runs branch from origin/<base>, so local WIP is invisible (DECISIONS D5).
    expect(existsSync(join(info.path, 'my-wip.ts'))).toBe(false);
    expect(existsSync(join(repo, 'my-wip.ts'))).toBe(true);
  });

  it('places worktrees in a sibling directory, not inside the repo', async () => {
    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    expect(info.path.startsWith(repo + '/')).toBe(false);
  });

  it('prefers origin/<base> over a stale local branch of the same name', async () => {
    // Move local main forward without pushing; the run must branch from origin.
    writeFileSync(join(repo, 'local-only.ts'), 'x\n');
    run(repo, 'add', '-A');
    run(repo, 'commit', '-m', 'local only');

    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    expect(existsSync(join(info.path, 'local-only.ts'))).toBe(false);
  });

  it('honours an explicit local ref when the caller asks for one', async () => {
    writeFileSync(join(repo, 'local-only.ts'), 'x\n');
    run(repo, 'add', '-A');
    run(repo, 'commit', '-m', 'local only');

    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'refs/heads/main' });
    expect(existsSync(join(info.path, 'local-only.ts'))).toBe(true);
  });

  it('refuses a base ref that does not exist', async () => {
    await expect(manager.create({ ticketKey: 'PAY-1', baseRef: 'nope' })).rejects.toThrow(/cannot resolve base ref/);
  });

  it('refuses to clobber an existing worktree path', async () => {
    await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    await expect(manager.create({ ticketKey: 'PAY-1', baseRef: 'main' })).rejects.toThrow(/already exists/);
  });

  it('re-attaches to an existing branch after its worktree was removed', async () => {
    const first = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    writeFileSync(join(first.path, 'work.ts'), 'export const done = true;\n');
    await manager.commit(first.path, '[PAY-1] work');
    await manager.remove('PAY-1');

    const again = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    expect(existsSync(join(again.path, 'work.ts'))).toBe(true);
  });
});

describe('tracking changes', () => {
  it('reports created, modified and deleted files against the base', async () => {
    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    writeFileSync(join(info.path, 'src.ts'), 'export const x = 2;\n');
    writeFileSync(join(info.path, 'new.ts'), 'export const y = 1;\n');
    rmSync(join(info.path, 'README.md'));
    await git(info.path, ['add', '-A']);

    const changed = await manager.changedFiles(info.path, info.baseSha);
    expect(changed).toContainEqual({ path: 'src.ts', op: 'modify' });
    expect(changed).toContainEqual({ path: 'new.ts', op: 'create' });
    expect(changed).toContainEqual({ path: 'README.md', op: 'delete' });
  });

  it('includes untracked files the agent has not staged', async () => {
    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    writeFileSync(join(info.path, 'unstaged.ts'), 'export const z = 1;\n');

    const changed = await manager.changedFiles(info.path, info.baseSha);
    expect(changed).toContainEqual({ path: 'unstaged.ts', op: 'create' });
  });

  it('reports a clean tree as not dirty', async () => {
    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    expect(await manager.isDirty(info.path)).toBe(false);
    writeFileSync(join(info.path, 'src.ts'), 'changed\n');
    expect(await manager.isDirty(info.path)).toBe(true);
  });
});

describe('checkpoints and rollback (§11.2)', () => {
  it('restores the tree to a checkpoint taken before an edit', async () => {
    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    writeFileSync(join(info.path, 'src.ts'), 'export const x = 99;\n');
    await git(info.path, ['add', '-A']);

    const checkpoint = await manager.checkpoint(info.path);
    expect(checkpoint).toBeDefined();

    writeFileSync(join(info.path, 'src.ts'), 'export const x = 1000;\n');
    await manager.restore(info.path, checkpoint!);

    expect(existsSync(join(info.path, 'src.ts'))).toBe(true);
    const { stdout } = await git(info.path, ['show', ':src.ts']);
    expect(stdout).toContain('99');
  });

  it('returns no checkpoint for a clean tree', async () => {
    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    expect(await manager.checkpoint(info.path)).toBeUndefined();
  });

  it('commits with provenance trailers', async () => {
    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    writeFileSync(join(info.path, 'feature.ts'), 'export const f = 1;\n');
    const sha = await manager.commit(info.path, '[PAY-1] Add feature', {
      'AgentFlow-Run': 'run-123', 'AgentFlow-Task': 'T1', 'AgentFlow-Gates': 'compile,unit',
    });

    expect(sha).toHaveLength(40);
    const { stdout } = await git(info.path, ['log', '-1', '--format=%B']);
    expect(stdout).toContain('AgentFlow-Run: run-123');
    expect(stdout).toContain('AgentFlow-Gates: compile,unit');
  });
});

describe('resume guard (§13.2)', () => {
  it('verifies a healthy worktree', async () => {
    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    const result = await manager.verify('PAY-1', { branch: info.branch, headSha: info.headSha });
    expect(result.ok).toBe(true);
  });

  it('blocks when the worktree is gone', async () => {
    await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    rmSync(manager.pathFor('PAY-1'), { recursive: true, force: true });

    const result = await manager.verify('PAY-1', { branch: 'agentflow/PAY-1' });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain('missing');
  });

  it('blocks when the branch changed underneath the run', async () => {
    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    await git(info.path, ['checkout', '-b', 'someone-elses-branch']);

    const result = await manager.verify('PAY-1', { branch: 'agentflow/PAY-1' });
    expect(result.ok === false && result.reason).toContain('someone-elses-branch');
  });

  it('blocks when HEAD moved from the last recorded checkpoint', async () => {
    const info = await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    const original = info.headSha;
    writeFileSync(join(info.path, 'extra.ts'), 'x\n');
    await manager.commit(info.path, 'moved on');

    const result = await manager.verify('PAY-1', { branch: info.branch, headSha: original });
    expect(result.ok === false && result.reason).toContain('HEAD is');
  });
});

describe('cleanup', () => {
  it('removes a worktree and prunes its metadata', async () => {
    await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    expect(await manager.list()).toHaveLength(2); // repo + worktree

    await manager.remove('PAY-1');
    expect(existsSync(manager.pathFor('PAY-1'))).toBe(false);
    expect(await manager.list()).toHaveLength(1);
  });

  it('tolerates removing a worktree whose directory already vanished', async () => {
    await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    rmSync(manager.pathFor('PAY-1'), { recursive: true, force: true });
    await expect(manager.remove('PAY-1')).resolves.toBeUndefined();
  });

  it('destroyAll clears every run tree but leaves the repository intact', async () => {
    await manager.create({ ticketKey: 'PAY-1', baseRef: 'main' });
    await manager.create({ ticketKey: 'PAY-2', baseRef: 'main' });
    await manager.destroyAll();

    expect(existsSync(manager.container)).toBe(false);
    expect(existsSync(join(repo, 'README.md'))).toBe(true);
    expect(await manager.list()).toHaveLength(1);
  });
});
