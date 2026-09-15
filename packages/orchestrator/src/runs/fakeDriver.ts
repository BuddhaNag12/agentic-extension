import { randomUUID } from 'node:crypto';
import { failureSignature, type Effect } from '@agentflow/core';
import type { Question, Step } from '@agentflow/protocol';
import type { RunStore } from './store.js';
import type { Scheduler } from '../scheduler.js';

/**
 * The simulated driver. It emits the same event shapes a real worker does, at
 * plausible rates, so the UI, the event log, replay and the gate/approval
 * plumbing can all be exercised deterministically and for free — which is what
 * the daemon tests and UI work need. `RealRunDriver` is the default; this is
 * selected by `AGENTFLOW_SIMULATE=1` (DECISIONS D33).
 */

interface Beat {
  after: number;
  emit: (ctx: DriverContext) => void;
}

interface DriverContext {
  runId: string;
  store: RunStore;
  say: (message: string) => void;
  file: (path: string, op: 'create' | 'modify' | 'delete', hunks: number) => void;
  tool: (tool: string, summary: string) => void;
  spend: (usd: number) => void;
  ask: (question: Question) => void;
}

const STEP_SCRIPT: Partial<Record<Step, Beat[]>> = {
  classify: [
    { after: 200, emit: (c) => c.tool('jira.getIssue', 'fetched issue and 4 comments') },
    { after: 250, emit: (c) => { c.say('classified as feature'); c.spend(0.004); } },
  ],
  map_repo: [
    { after: 150, emit: (c) => c.say('mapped to the configured repo on origin/main') },
  ],
  check_auth: [
    { after: 120, emit: (c) => c.say('integration auth valid') },
  ],
  worktree: [
    { after: 200, emit: (c) => c.store.emitEvent(c.store.get(c.runId)!, { t: 'checkpoint', label: 'worktree agentflow branch', commitSha: 'f0e1d2c' }) },
  ],
  detect_gates: [
    { after: 150, emit: (c) => c.say('gate adapters detected: compile, lint, unit') },
  ],
  check_budget: [
    { after: 100, emit: (c) => c.say('budget: $8 and 90 minutes') },
  ],
  baseline_gates: [
    { after: 300, emit: (c) => gate(c, 'compile', true, 1_300) },
    { after: 400, emit: (c) => { gate(c, 'unit', true, 3_900); c.say('baseline is green'); } },
  ],
  harvest: [
    { after: 300, emit: (c) => c.tool('subagent:repo-cartographer', 'mapped 12 modules') },
    { after: 300, emit: (c) => c.tool('subagent:test-cartographer', 'found 3 fixture helpers') },
    { after: 300, emit: (c) => { c.tool('subagent:history-archaeologist', '2 prior PRs in this area'); c.spend(0.21); } },
    { after: 200, emit: (c) => c.store.emitEvent(c.store.get(c.runId)!, { t: 'artifact_written', kind: 'context', version: 1, path: 'artifacts/context.v1.json' }) },
  ],
  draft_spec: [
    { after: 400, emit: (c) => c.say('drafting spec from ticket + context') },
    { after: 500, emit: (c) => { c.store.emitEvent(c.store.get(c.runId)!, { t: 'artifact_written', kind: 'spec', version: 1, path: 'artifacts/spec.v1.json' }); c.spend(0.42); } },
  ],
  questions: [
    {
      after: 300,
      emit: (c) => c.ask({
        id: randomUUID(),
        question: 'Should the empty state be behind the existing checkout_v2 flag, or its own?',
        whyItMatters: 'Determines rollout granularity and whether QA can toggle it alone.',
        alreadyChecked: ['grepped FeatureFlags.kt', 'read the ticket ACs', 'checked the Figma frame notes'],
        options: [
          { label: 'Reuse checkout_v2', implication: 'Ships with the rest of checkout; no new flag to clean up.' },
          { label: 'New flag', implication: 'Independent rollout, one more flag to retire later.' },
        ],
        allowFreeText: true,
        blocking: true,
        confidenceWithoutAnswer: 0.4,
        phase: 'context',
      }),
    },
  ],
  draft_plan: [
    { after: 400, emit: (c) => c.say('compiling task DAG') },
    { after: 400, emit: (c) => { c.store.emitEvent(c.store.get(c.runId)!, { t: 'artifact_written', kind: 'plan', version: 1, path: 'artifacts/plan.v1.json' }); c.spend(0.55); } },
  ],
  validate_plan: [
    { after: 200, emit: (c) => c.say('PLAN_VALID passed all seven rules') },
  ],
  decompose: [
    { after: 200, emit: (c) => c.say('compiled 3 work packets') },
  ],
  implement: [
    { after: 250, emit: (c) => c.store.emitEvent(c.store.get(c.runId)!, { t: 'checkpoint', label: 'before T1', commitSha: 'a1b2c3d' }) },
    { after: 350, emit: (c) => { c.store.emitEvent(c.store.get(c.runId)!, { t: 'task_status', taskId: 'T1', status: 'active' }); c.file('src/checkout/EmptyState.kt', 'create', 4); } },
    { after: 350, emit: (c) => c.file('src/checkout/CheckoutViewModel.kt', 'modify', 2) },
    { after: 350, emit: (c) => { c.file('test/checkout/EmptyStateTest.kt', 'create', 3); c.spend(0.18); } },
    { after: 200, emit: (c) => c.store.emitEvent(c.store.get(c.runId)!, { t: 'task_status', taskId: 'T1', status: 'verifying' }) },
  ],
  verify: [
    { after: 300, emit: (c) => gate(c, 'compile', true, 1_400) },
    { after: 300, emit: (c) => gate(c, 'lint', true, 900) },
    { after: 500, emit: (c) => gate(c, 'unit', true, 4_200) },
  ],
  auto_review: [
    { after: 500, emit: (c) => c.tool('subagent:correctness', 'no blocking findings') },
    { after: 400, emit: (c) => { c.tool('subagent:security', 'no blocking findings'); c.store.emitEvent(c.store.get(c.runId)!, { t: 'artifact_written', kind: 'review', version: 1, path: 'artifacts/review.v1.json' }); c.spend(0.61); } },
  ],
  triage_findings: [
    { after: 200, emit: (c) => c.say('assembled diff, gate reports and plan conformance') },
  ],
  // §5.8: ship prepares the branch and stops. `push`, `publish` and `notify`
  // are gated behind autoPush and are not scripted, because simulating an
  // outbound action the tool does not take by default is exactly the kind of
  // convincing fiction that made someone ask which origin the PR went to.
  rebase: [
    { after: 300, emit: (c) => c.tool('git.rebase', 'rebased onto origin/main, no conflicts') },
    { after: 400, emit: (c) => gate(c, 'unit', true, 4_100) },
    {
      after: 300,
      emit: (c) => {
        c.store.emitEvent(c.store.get(c.runId)!, {
          t: 'artifact_written', kind: 'prpackage', version: 1, path: 'artifacts/pr-package.md',
        });
        c.say('ready to push: 3 commit(s) over origin/main. PR body in artifacts/pr-package.md');
      },
    },
  ],
};

function gate(c: DriverContext, id: string, ok: boolean, durationMs: number): void {
  c.store.emitEvent(c.store.get(c.runId)!, {
    t: 'gate_result',
    gate: id,
    ok,
    durationMs,
    report: { gate: id, ok, exitCode: ok ? 0 : 1, durationMs, failures: [], signature: failureSignature([]) },
  });
}

export class FakeRunDriver {
  private readonly timers = new Map<string, NodeJS.Timeout[]>();

  constructor(
    private readonly store: RunStore,
    private readonly scheduler: Scheduler,
    private readonly onEffects: (runId: string, effects: Effect[]) => void,
    /** Returns false when the phase's question budget is spent (§7.2). */
    private readonly onQuestion: (runId: string, question: Question) => boolean,
    /** Scales every scripted delay. Tests run at ~0.02; the UI wants 1. */
    private readonly timeScale = Number(process.env['AGENTFLOW_FAKE_TIME_SCALE'] ?? 1),
  ) {}

  /** Kick a run off at its current step. */
  start(runId: string): void {
    this.step(runId, { kind: 'start' });
  }

  /** Apply a trigger, then drive whatever step we land in. */
  step(runId: string, trigger: Parameters<RunStore['apply']>[1]): void {
    const result = this.store.apply(runId, trigger);
    if (!result.ok) return;
    this.onEffects(runId, result.effects);

    const handle = this.store.get(runId);
    if (!handle?.machine.step || handle.machine.status !== 'running') return;
    this.runStep(runId, handle.machine.step);
  }

  cancel(runId: string): void {
    for (const t of this.timers.get(runId) ?? []) clearTimeout(t);
    this.timers.delete(runId);
  }

  cancelAll(): void {
    for (const runId of [...this.timers.keys()]) this.cancel(runId);
  }

  private runStep(runId: string, step: Step): void {
    // A run parked at G3 sits in `human_review` and must not be driven on:
    // the machine is waiting for a person, not for the script.
    if (step === 'human_review') return;

    const script = STEP_SCRIPT[step] ?? [];
    const ctx = this.context(runId);
    const timers: NodeJS.Timeout[] = [];
    let elapsed = 0;

    for (const beat of script) {
      elapsed += beat.after * this.timeScale;
      timers.push(setTimeout(() => {
        if (this.store.get(runId)?.machine.status === 'running') beat.emit(ctx);
      }, elapsed));
    }

    // The step's work is done — ask the machine what happens next. Gates run
    // under their own semaphore so parallel runs cannot all build at once (§4.3).
    timers.push(setTimeout(() => {
      const handle = this.store.get(runId);
      if (!handle || handle.machine.status !== 'running') return;
      void this.finishStep(runId, step);
    }, elapsed + 300 * this.timeScale));

    this.timers.set(runId, [...(this.timers.get(runId) ?? []), ...timers]);
  }

  private async finishStep(runId: string, step: Step): Promise<void> {
    if (step === 'verify' || step === 'baseline_gates') {
      await this.scheduler.gates.run(async () => { /* held for the gate's duration */ });
    }
    this.step(runId, exitTrigger(step));
  }

  private context(runId: string): DriverContext {
    const store = this.store;
    const handle = () => store.get(runId)!;
    return {
      runId,
      store,
      say: (message) => store.emitEvent(handle(), { t: 'log', level: 'info', message }),
      file: (path, op, hunks) => store.emitEvent(handle(), { t: 'file_changed', path, op, hunks }),
      tool: (tool, summaryLine) => {
        const toolUseId = randomUUID();
        store.emitEvent(handle(), { t: 'tool_call', tool, toolUseId, summaryLine: `calling ${tool}` });
        store.emitEvent(handle(), { t: 'tool_result', toolUseId, ok: true, summaryLine });
      },
      ask: (question) => {
        // A refused question is not logged: the agent is told to assume instead.
        if (this.onQuestion(runId, question)) {
          store.emitEvent(handle(), { t: 'question_asked', question });
        }
      },
      spend: (usd) => store.emitEvent(handle(), {
        t: 'cost', usd, inputTokens: Math.round(usd * 9000), outputTokens: Math.round(usd * 900), model: 'sonnet',
      }),
    };
  }
}

/** How each step reports completion. Verify and review report evidence. */
function exitTrigger(step: Step): Parameters<RunStore['apply']>[1] {
  switch (step) {
    case 'verify': return { kind: 'gate_passed', gate: 'unit' };
    case 'auto_review': return { kind: 'review_findings', blocking: 0 };
    default: return { kind: 'advance' };
  }
}
