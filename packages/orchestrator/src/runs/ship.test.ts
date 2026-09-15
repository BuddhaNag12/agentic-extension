import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GateRegistry, type GateAdapter } from '@agentflow/gates';
import { workspacePaths, type WorkspacePaths } from '../paths.js';
import { Scheduler } from '../scheduler.js';
import { WorktreeManager } from '../git/worktree.js';
import { RunStore } from './store.js';
import { RealRunDriver } from './realDriver.js';

/**
 * Ship, against real git (§5.8). The step calls no model, so it can be driven
 * end to end: a branch with commits becomes a rebased branch, a re-run ladder
 * and a PR package on disk — and the run stops there rather than pushing.
 */

let root: string;
let repo: string;
let paths: WorkspacePaths;
let store: RunStore;
let driver: RealRunDriver;
let ran: string[];

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * A gate that really runs: `true` or `false` through the real runner, so the
 * exit code decides the result the way it does in production. A stub that
 * returned its own verdict would not exercise the thing being tested.
 */
const stubGate = (id: string, ok: boolean): GateAdapter => ({
  id,
  level: 0,
  blocking: true,
  detect: () => true,
  command: (_scope, repoCtx) => {
    ran.push(id);
    return { cmd: ok ? 'true' : 'false', args: [], cwd: repoCtx.root };
  },
  parse: () => [],
});

function setUp(gates: GateAdapter[]): void {
  ran = [];
  store = new RunStore(paths);
  driver = new RealRunDriver(
    paths, store, new Scheduler(),
    () => { /* effects are the daemon's business */ },
    // Ship calls no model; a provider that throws proves it.
    { run: () => { throw new Error('ship must not call a model'); } } as never,
    new GateRegistry(gates),
  );
}

/** Put a run at ship/rebase with a committed branch, the way G3 leaves it. */
async function readyToShip(): Promise<{ runId: string; worktree: string }> {
  const handle = store.create({ ticketKey: 'PAY-1', summary: 'ship me', baseRef: 'main' });
  const tree = new WorktreeManager(paths.root);
  const info = await tree.create({ ticketKey: 'PAY-1', baseRef: 'main' });

  writeFileSync(join(info.path, 'feature.ts'), 'export const f = 1;\n');
  await tree.commit(info.path, 'PAY-1: add the feature', { 'AgentFlow-Task': 'T1' });

  handle.machine = { ...handle.machine, phase: 'ship', step: 'rebase' };
  driver['artifacts'].set(handle.id, { worktree: info.path, baseSha: info.baseSha, packets: [] });
  return { runId: handle.id, worktree: info.path };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentflow-ship-'));

  const origin = join(root, 'origin.git');
  mkdirSync(origin);
  run(origin, 'init', '--bare', '--initial-branch=main');

  repo = join(root, 'repo');
  mkdirSync(repo);
  run(repo, 'init', '--initial-branch=main');
  run(repo, 'config', 'user.email', 'test@example.com');
  run(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'src.ts'), 'export const x = 1;\n');
  run(repo, 'add', '-A');
  run(repo, 'commit', '-m', 'base');
  run(repo, 'remote', 'add', 'origin', origin);
  run(repo, 'push', '-u', 'origin', 'main');

  paths = workspacePaths(repo);
  setUp([stubGate('unit', true)]);
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const statusOf = (runId: string) => store.get(runId)!.run.status;
const packagePath = (runId: string) => join(paths.runsDir, runId, 'artifacts', 'pr-package.md');

describe('ship prepares and hands off (§5.8)', () => {
  it('rebases, re-runs the ladder, writes the package and stops', async () => {
    const { runId } = await readyToShip();
    driver.start(runId);
    await settle(runId);

    expect(existsSync(packagePath(runId))).toBe(true);
    const md = readFileSync(packagePath(runId), 'utf8');
    expect(md).toContain('PAY-1: add the feature');
    expect(md).toContain('Nothing has been pushed');
    expect(statusOf(runId)).toBe('succeeded');
  });

  it('re-runs the ladder on the rebased tree — the earlier green was another tree', async () => {
    const { runId } = await readyToShip();
    driver.start(runId);
    await settle(runId);
    expect(ran).toContain('unit');
  });

  it('never pushes: no commit reaches origin', async () => {
    const { runId } = await readyToShip();
    driver.start(runId);
    await settle(runId);

    const remote = run(join(root, 'origin.git'), 'log', '--oneline', 'main');
    expect(remote).not.toContain('add the feature');
    expect(remote.trim().split('\n')).toHaveLength(1);
  });

  it('blocks on a conflict instead of resolving it (§13.3)', async () => {
    const { runId, worktree } = await readyToShip();
    // The run and the base both changed the same line.
    writeFileSync(join(worktree, 'src.ts'), 'export const x = 2;\n');
    await new WorktreeManager(paths.root).commit(worktree, 'PAY-1: touch src');
    writeFileSync(join(repo, 'src.ts'), 'export const x = 3;\n');
    run(repo, 'add', '-A');
    run(repo, 'commit', '-m', 'base moved');
    run(repo, 'push', 'origin', 'main');

    driver.start(runId);
    await settle(runId);

    expect(statusOf(runId)).toBe('blocked');
    expect(existsSync(packagePath(runId))).toBe(false);
    const errors = store.events(runId).filter((e) => e.t === 'error');
    expect(errors.at(-1)).toMatchObject({ message: expect.stringContaining('src.ts') });
  });

  it('blocks when a gate is red on the rebased tree', async () => {
    setUp([stubGate('unit', false)]);
    const { runId } = await readyToShip();
    driver.start(runId);
    await settle(runId);

    expect(statusOf(runId)).toBe('blocked');
    // No package: a hand-off card for a red tree is an invitation to merge it.
    expect(existsSync(packagePath(runId))).toBe(false);
  });

  it('blocks a branch with no commits rather than shipping an empty PR', async () => {
    const handle = store.create({ ticketKey: 'PAY-2', summary: 'nothing', baseRef: 'main' });
    const info = await new WorktreeManager(paths.root).create({ ticketKey: 'PAY-2', baseRef: 'main' });
    handle.machine = { ...handle.machine, phase: 'ship', step: 'rebase' };
    driver['artifacts'].set(handle.id, { worktree: info.path, baseSha: info.baseSha, packets: [] });

    driver.start(handle.id);
    await settle(handle.id);

    expect(statusOf(handle.id)).toBe('blocked');
    const errors = store.events(handle.id).filter((e) => e.t === 'error');
    expect(errors.at(-1)).toMatchObject({ message: expect.stringContaining('no commits') });
  });

  it('does not block on a gate that was already red on the base (§5.3)', async () => {
    setUp([stubGate('unit', false)]);
    const { runId } = await readyToShip();
    // Preflight recorded this gate as failing on the untouched base. Recording
    // that and then still blocking on it would make the baseline run
    // decorative — the run would inherit blame for a broken `main`.
    driver['artifacts'].set(runId, {
      ...driver['artifacts'].get(runId)!,
      baselineFailures: ['unit'],
    });

    driver.start(runId);
    await settle(runId);

    expect(statusOf(runId)).toBe('succeeded');
    expect(existsSync(packagePath(runId))).toBe(true);
    // Still reported, so it reaches the human and the PR package either way.
    const gates = store.events(runId).filter((e) => e.t === 'gate_result');
    expect(gates.at(-1)).toMatchObject({ gate: 'unit', ok: false });
  });

  it('records the package as an artifact so the UI can open it', async () => {
    const { runId } = await readyToShip();
    driver.start(runId);
    await settle(runId);

    const written = store.events(runId).filter((e) => e.t === 'artifact_written');
    expect(written.at(-1)).toMatchObject({ kind: 'prpackage', version: 1 });
  });
});

/**
 * Ship is several awaited git calls deep. Wait for the run to stop moving
 * rather than for a fixed duration, so a slow machine does not fail the test
 * and a fast one does not pay for the slack.
 */
async function settle(runId: string): Promise<void> {
  const done = new Set(['succeeded', 'blocked', 'failed', 'cancelled', 'waiting_human']);
  for (let i = 0; i < 400; i += 1) {
    if (done.has(store.get(runId)?.run.status ?? '')) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run never settled; last status ${store.get(runId)?.run.status}`);
}
