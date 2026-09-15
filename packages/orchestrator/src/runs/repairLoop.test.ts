import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GateRegistry, type GateAdapter } from '@agentflow/gates';
import type { AgentProvider, AgentSession, AgentTurn, WorkPacket } from '@agentflow/agent-runtime';
import { workspacePaths, type WorkspacePaths } from '../paths.js';
import { Scheduler } from '../scheduler.js';
import { WorktreeManager } from '../git/worktree.js';
import { RunStore } from './store.js';
import { RealRunDriver } from './realDriver.js';

/**
 * The bounded convergence loop (§11), driven end to end against real git.
 *
 * Every way out of the loop is a different transition, and getting one wrong is
 * how a loop either gives up on a fixable failure or burns the budget proving
 * it cannot fix an unfixable one.
 */

let root: string;
let repo: string;
let paths: WorkspacePaths;
let store: RunStore;
let driver: RealRunDriver;
let repairCalls: number;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Gate results, one per call, so a test scripts red-then-green. */
let gateScript: boolean[];
const scriptedGate = (): GateAdapter => ({
  id: 'unit',
  level: 0,
  blocking: true,
  detect: () => true,
  command: (_scope, repoCtx) => {
    const ok = gateScript.shift() ?? true;
    return { cmd: ok ? 'true' : 'false', args: [], cwd: repoCtx.root };
  },
  // A stable failure, so repeated reds hash to the same signature (§11.1).
  parse: (_out, _err, exitCode) =>
    exitCode === 0 ? [] : [{ file: 'src/a.test.ts', line: 3, message: 'expected 1 to be 2' }],
});

/**
 * A provider whose repair really writes, and writes the way the real one does
 * — *through the permission hook*. Writing straight to disk would leave
 * `filesTouched` empty and the repair would be rejected as a fix that wrote
 * nothing, which is the guard working correctly against a lying stub.
 */
function provider(worktreeOf: () => string): AgentProvider {
  return {
    id: 'stub',
    capabilities: () => ({
      hooks: true, subagents: false, structuredOutput: true, checkpointing: true, permissions: true,
    }),
    supportedModels: async () => ['stub'],
    createSession: async (opts): Promise<AgentSession> => ({
      id: 'stub-session',
      async *send(): AsyncIterable<AgentTurn> {
        // Only repair is scripted. Anything else — the planner, after a thrash
        // escalation hands the task back — stops the run so these tests stay
        // about the loop.
        if (opts.role !== 'repair') {
          yield { type: 'error', error: `stub provider has no ${opts.role}` };
          return;
        }
        repairCalls += 1;
        const file = join(worktreeOf(), 'fix.ts');
        const decision = opts.permissionHook?.(
          { tool: 'Write', input: { file_path: file } },
          opts.guardrails,
        );
        if (decision && decision.decision !== 'allow') {
          yield { type: 'error', error: `denied: ${decision.reason}` };
          return;
        }
        writeFileSync(file, `export const fix = ${repairCalls};\n`);
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, usd: 0.01 } };
        yield {
          type: 'done',
          result: {
            diagnosis: `attempt ${repairCalls}: the assertion disagrees with the implementation`,
            fix: 'adjust the implementation',
            changed: [{ path: 'fix.ts', what: 'corrected the returned value' }],
            approach: `attempt ${repairCalls}: corrected the returned value`,
            confidence: 0.6,
          },
        };
      },
      interrupt: async () => {},
      close: async () => {},
    }),
  } as unknown as AgentProvider;
}

const packet = (): WorkPacket => ({
  task: {
    id: 'T1', title: 'make it green', intent: 'fix the failing assertion',
    files: ['fix.ts'], dependsOn: [], satisfies: [], checks: [{ gate: 'unit', how: 'unit passes' }],
    risk: 'low', estimatedEdits: 1,
  },
  contextSlice: { files: ['fix.ts'], specExcerpt: [], conventions: [], completed: [] },
  gates: ['unit'],
  guardrails: { allowedPaths: ['**'], forbiddenPaths: [], maxFilesTouched: 10, maxNewDeps: 0 },
} as unknown as WorkPacket);

let worktree: string;

async function atRepair(attemptsPerTask = 4): Promise<string> {
  const handle = store.create({ ticketKey: 'PAY-1', summary: 'repair me', baseRef: 'main' });
  const tree = new WorktreeManager(paths.root);
  const info = await tree.create({ ticketKey: 'PAY-1', baseRef: 'main' });
  worktree = info.path;

  writeFileSync(join(info.path, 'fix.ts'), 'export const fix = 0;\n');
  await tree.commit(info.path, 'PAY-1: first cut');
  // The same fallback the driver uses: a clean tree has no stash to create,
  // and HEAD is what "before this task" means.
  const checkpoint = (await tree.checkpoint(info.path)) ?? (await tree.head(info.path));

  const wf = store.workflows.workflows.get('feature')!.resolved;
  wf.budgets.attemptsPerTask = attemptsPerTask;
  wf.pipeline.gates.required = ['unit'];

  handle.machine = { ...handle.machine, phase: 'build', step: 'repair' };
  driver['artifacts'].set(handle.id, {
    worktree: info.path,
    baseSha: info.baseSha,
    packets: [packet()],
    ...(checkpoint ? { taskCheckpoints: { T1: checkpoint } } : {}),
    repairing: { gate: 'unit', failures: [{ file: 'src/a.test.ts', message: 'expected 1 to be 2' }], taskId: 'T1' },
  });
  return handle.id;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentflow-repair-'));
  repairCalls = 0;
  gateScript = [];

  const origin = join(root, 'origin.git');
  mkdirSync(origin);
  git(origin, 'init', '--bare', '--initial-branch=main');

  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'src.ts'), 'export const x = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-u', 'origin', 'main');

  paths = workspacePaths(repo);
  store = new RunStore(paths);
  driver = new RealRunDriver(
    paths, store, new Scheduler(), () => {},
    provider(() => worktree), new GateRegistry([scriptedGate()]),
  );
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const events = (runId: string, t: string) => store.events(runId).filter((e) => e.t === t);
const statusOf = (runId: string) => store.get(runId)!.run.status;

async function settle(runId: string): Promise<void> {
  const done = new Set(['succeeded', 'blocked', 'failed', 'cancelled', 'waiting_human']);
  for (let i = 0; i < 400; i += 1) {
    const h = store.get(runId)!;
    if (done.has(h.run.status)) return;
    // Converged runs walk on to review; that is far enough for these.
    if (h.machine.phase === 'review') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never settled; ${store.get(runId)!.run.status}`);
}

describe('the repair loop converges', () => {
  it('fixes the failure and sends the tree back to verify, not onward', async () => {
    gateScript = [true]; // the re-run after the first repair is green
    const runId = await atRepair();
    driver.start(runId);
    await settle(runId);

    expect(repairCalls).toBe(1);
    // STEP_AFTER sends repair → verify: a repaired tree that skipped
    // verification would reach review unverified.
    const steps = events(runId, 'step_entered').map((e) => (e as { step: string }).step);
    expect(steps).toContain('verify');
  });

  it('records each attempt as a repairing task, so the UI can show it', async () => {
    gateScript = [true];
    const runId = await atRepair();
    driver.start(runId);
    await settle(runId);

    const repairing = events(runId, 'task_status')
      .filter((e) => (e as { status: string }).status === 'repairing');
    expect(repairing.length).toBeGreaterThan(0);
  });
});

describe('the repair loop gives up the right way', () => {
  it('escalates on a repeated signature rather than spending the budget', async () => {
    // The same failure twice: §11.1 says more attempts of the same kind will
    // not help, and proving it is the thrash the budget exists to stop.
    gateScript = [false, false, false, false];
    const runId = await atRepair(4);
    driver.start(runId);
    await settle(runId);

    // Two attempts, not four: the second produced an identical signature.
    expect(repairCalls).toBe(2);
    const logs = store.events(runId).map((e) => JSON.stringify(e)).join('\n');
    expect(logs).toMatch(/repeat|oscillation/);
  });

  it('rewinds the worktree to the pre-task checkpoint before replanning', async () => {
    gateScript = [false, false, false, false];
    const runId = await atRepair(4);
    driver.start(runId);
    await settle(runId);

    // Rung 4 actually rewinds now — replanning on a half-repaired tree would
    // hand the planner a state no plan describes.
    expect(readFileSync(join(worktree, 'fix.ts'), 'utf8')).toBe('export const fix = 0;\n');
    const labels = events(runId, 'checkpoint').map((e) => (e as { label: string }).label);
    expect(labels.some((l) => l.includes('rewound'))).toBe(true);
  });

  it('hands the task back to the planner, clearing G2', async () => {
    gateScript = [false, false, false, false];
    const runId = await atRepair(4);
    driver.start(runId);
    await settle(runId);

    const machine = store.get(runId)!.machine;
    expect(machine.phase).toBe('plan');
    expect(machine.step).toBe('draft_plan');
    // The plan is different now, so the approval given to the old one is void.
    expect(machine.gatesPassed).not.toContain('G2');
  });

  it('exhausts the budget when each attempt fails differently', async () => {
    // Genuinely distinct failures, so nothing looks like thrash and the budget
    // is what binds. Distinct *words*, not distinct numbers: the signature
    // normalizes digits to `<n>` and drops line numbers, so "failure 1" and
    // "failure 2" are the same failure as far as §11.1 is concerned.
    const messages = ['cart total is wrong', 'discount is not applied', 'tax rounds the wrong way'];
    let n = 0;
    driver = new RealRunDriver(
      paths, store, new Scheduler(), () => {},
      provider(() => worktree),
      new GateRegistry([{
        ...scriptedGate(),
        command: (_s, r) => ({ cmd: 'false', args: [], cwd: r.root }),
        parse: () => [{ file: 'src/a.test.ts', message: messages[n++ % messages.length]! }],
      } as GateAdapter]),
    );
    const runId = await atRepair(3);
    driver.start(runId);
    await settle(runId);

    expect(repairCalls).toBe(3);
    expect(statusOf(runId)).toBe('blocked');
    const errors = store.events(runId).filter((e) => e.t === 'status_changed');
    expect(JSON.stringify(errors)).toMatch(/budget exhausted/);
  });

  it('abandons the task rather than leaving it looking active', async () => {
    gateScript = [false, false, false, false];
    const runId = await atRepair(4);
    driver.start(runId);
    await settle(runId);

    const abandoned = events(runId, 'task_status')
      .filter((e) => (e as { status: string }).status === 'abandoned');
    expect(abandoned).toHaveLength(1);
  });
});
