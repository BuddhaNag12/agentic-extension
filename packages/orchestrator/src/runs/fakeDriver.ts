import { randomUUID } from 'node:crypto';
import { failureSignature, type Effect } from '@agentflow/core';
import type { Phase, Question } from '@agentflow/protocol';
import type { RunStore } from './store.js';
import type { Scheduler } from '../scheduler.js';

/**
 * M0's stand-in for real phase work. It emits the same event shapes a real
 * worker will, at plausible rates, so the UI, the event log, replay and the
 * gate/approval plumbing are all exercised end to end before a single model
 * call exists. M1 replaces this with real workers; the events do not change.
 */

interface Step {
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

const PHASE_SCRIPT: Partial<Record<Phase, Step[]>> = {
  intake: [
    { after: 200, emit: (c) => c.tool('jira.getIssue', 'fetched issue and 4 comments') },
    { after: 250, emit: (c) => { c.say('classified as feature'); c.spend(0.004); } },
  ],
  harvest: [
    { after: 300, emit: (c) => c.tool('subagent:repo-cartographer', 'mapped 12 modules') },
    { after: 300, emit: (c) => c.tool('subagent:test-cartographer', 'found 3 fixture helpers') },
    { after: 300, emit: (c) => { c.tool('subagent:history-archaeologist', '2 prior PRs in this area'); c.spend(0.21); } },
    { after: 200, emit: (c) => c.store.emitEvent(c.store.get(c.runId)!, { t: 'artifact_written', kind: 'context', version: 1, path: 'artifacts/context.v1.json' }) },
  ],
  spec: [
    { after: 400, emit: (c) => c.say('drafting spec from ticket + context') },
    { after: 500, emit: (c) => { c.store.emitEvent(c.store.get(c.runId)!, { t: 'artifact_written', kind: 'spec', version: 1, path: 'artifacts/spec.v1.json' }); c.spend(0.42); } },
  ],
  clarify: [
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
        phase: 'clarify',
      }),
    },
  ],
  plan: [
    { after: 400, emit: (c) => c.say('compiling task DAG') },
    { after: 400, emit: (c) => { c.store.emitEvent(c.store.get(c.runId)!, { t: 'artifact_written', kind: 'plan', version: 1, path: 'artifacts/plan.v1.json' }); c.spend(0.55); } },
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
  review: [
    { after: 500, emit: (c) => c.tool('subagent:correctness', 'no blocking findings') },
    { after: 400, emit: (c) => { c.tool('subagent:security', 'no blocking findings'); c.store.emitEvent(c.store.get(c.runId)!, { t: 'artifact_written', kind: 'review', version: 1, path: 'artifacts/review.v1.json' }); c.spend(0.61); } },
  ],
  human_review: [
    { after: 200, emit: (c) => c.say('assembled diff, gate reports and plan conformance') },
  ],
  ship: [
    { after: 300, emit: (c) => c.tool('git.push', 'pushed agentflow branch') },
    { after: 300, emit: (c) => c.tool('github.createPR', 'opened PR #4821') },
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

  /** Kick a run off at its current phase. */
  start(runId: string): void {
    this.step(runId, { kind: 'advance' });
  }

  /** Apply a trigger, then drive whatever phase we land in. */
  step(runId: string, trigger: Parameters<RunStore['apply']>[1]): void {
    const result = this.store.apply(runId, trigger);
    if (!result.ok) return;
    this.onEffects(runId, result.effects);

    const handle = this.store.get(runId);
    if (!handle || handle.machine.status !== 'running') return;
    this.runPhase(runId, handle.machine.phase);
  }

  cancel(runId: string): void {
    for (const t of this.timers.get(runId) ?? []) clearTimeout(t);
    this.timers.delete(runId);
  }

  cancelAll(): void {
    for (const runId of [...this.timers.keys()]) this.cancel(runId);
  }

  private runPhase(runId: string, phase: Phase): void {
    const script = PHASE_SCRIPT[phase] ?? [];
    const ctx = this.context(runId);
    const timers: NodeJS.Timeout[] = [];
    let elapsed = 0;

    for (const step of script) {
      elapsed += step.after * this.timeScale;
      timers.push(setTimeout(() => {
        if (this.store.get(runId)?.machine.status === 'running') step.emit(ctx);
      }, elapsed));
    }

    // Phase work is done — ask the machine what happens next. Gates run under
    // their own semaphore so parallel runs cannot all build at once (§4.3).
    timers.push(setTimeout(() => {
      const handle = this.store.get(runId);
      if (!handle || handle.machine.status !== 'running') return;
      void this.finishPhase(runId, phase);
    }, elapsed + 300 * this.timeScale));

    this.timers.set(runId, [...(this.timers.get(runId) ?? []), ...timers]);
  }

  private async finishPhase(runId: string, phase: Phase): Promise<void> {
    const trigger = exitTrigger(phase);
    if (phase === 'verify') {
      await this.scheduler.gates.run(async () => { /* held for the gate's duration */ });
    }
    this.step(runId, trigger);
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

/** How each phase reports completion. Verify and review report evidence. */
function exitTrigger(phase: Phase): Parameters<RunStore['apply']>[1] {
  switch (phase) {
    case 'verify': return { kind: 'gate_passed', gate: 'unit' };
    case 'review': return { kind: 'review_findings', blocking: 0 };
    default: return { kind: 'advance' };
  }
}
