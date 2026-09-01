import type { HumanGate, Phase, RunStatus } from '@agentflow/protocol';
import { nextPhase, type PipelineOptions } from './profiles.js';
import type { Trigger } from './triggers.js';

/**
 * The run state machine (§5, §6.4). Orchestration is code, not a model: every
 * transition here is an ordinary, testable function. Nothing advances because
 * an agent asserted success.
 */

export interface MachineState {
  phase: Phase;
  status: RunStatus;
  /** clarify → spec loops. Limit 2 (§5 Stage 3). */
  reSpecCount: number;
  /** PLAN_VALID rejections. Limit 3, then escalate to the human (§5 Stage 4). */
  planValidationAttempts: number;
  /** Repair attempts for the current task. Bounded by attemptBudget (§9.2). */
  repairAttempts: number;
  /** Failure signatures seen this task, oldest first — drives §9.1 detection. */
  signatures: string[];
  /** Human gates satisfied for the current pass. Cleared when a loop-back
   *  invalidates the decision, so a revised artifact is always re-approved. */
  gatesPassed: HumanGate[];
  blockedReason?: string;
}

export type Effect =
  | { kind: 'run_phase'; phase: Phase }
  | { kind: 'request_approval'; gate: HumanGate }
  | { kind: 'escalate_to_human'; reason: string }
  | { kind: 'rewind_to_task_checkpoint' }
  | { kind: 'replan' }
  | { kind: 'finalize'; status: RunStatus };

export type TransitionResult =
  | { ok: true; state: MachineState; effects: Effect[] }
  /** Illegal transitions are an error, never a silent no-op — a swallowed
   *  trigger is how a run quietly stalls forever. */
  | { ok: false; reason: string };

export const RE_SPEC_LIMIT = 2;
export const PLAN_VALIDATION_LIMIT = 3;

/** Gates are evaluated on exit from these phases (§5 state diagram). */
const HUMAN_GATE_AT: Partial<Record<Phase, HumanGate>> = {
  clarify: 'G1',
  plan: 'G2',
  human_review: 'G3',
};

const TERMINAL: readonly RunStatus[] = ['failed', 'cancelled', 'succeeded'];

export function initialState(): MachineState {
  return {
    phase: 'intake',
    status: 'queued',
    reSpecCount: 0,
    planValidationAttempts: 0,
    repairAttempts: 0,
    signatures: [],
    gatesPassed: [],
  };
}

export function isTerminal(s: MachineState): boolean {
  return TERMINAL.includes(s.status);
}

export function gateFor(phase: Phase): HumanGate | undefined {
  return HUMAN_GATE_AT[phase];
}

export function transition(
  state: MachineState,
  trigger: Trigger,
  opts: PipelineOptions,
): TransitionResult {
  if (isTerminal(state)) {
    return { ok: false, reason: `run is ${state.status}; no transitions remain` };
  }

  const s: MachineState = {
    ...state,
    signatures: [...state.signatures],
    gatesPassed: [...state.gatesPassed],
  };

  switch (trigger.kind) {
    case 'cancel':
      return ok({ ...s, status: 'cancelled' }, [{ kind: 'finalize', status: 'cancelled' }]);

    case 'blocked':
      return ok({ ...s, status: 'blocked', blockedReason: trigger.reason }, [
        { kind: 'escalate_to_human', reason: trigger.reason },
      ]);

    case 'resume': {
      if (s.status !== 'blocked' && s.status !== 'waiting_human') {
        return { ok: false, reason: `cannot resume from status ${s.status}` };
      }
      const { blockedReason: _drop, ...rest } = s;
      return ok({ ...rest, status: 'running' }, [{ kind: 'run_phase', phase: s.phase }]);
    }

    case 'advance':
      return advance(s, opts);

    case 'gate_passed':
      if (s.phase !== 'verify') {
        return { ok: false, reason: `gate_passed is only meaningful in verify, not ${s.phase}` };
      }
      // All gates green. The repair budget is per task, so it resets here.
      return advance({ ...s, repairAttempts: 0, signatures: [] }, opts);

    case 'gate_failed':
      if (s.phase !== 'verify' && s.phase !== 'implement') {
        return { ok: false, reason: `gate_failed is not expected in ${s.phase}` };
      }
      return ok({ ...s, phase: 'repair', status: 'running' }, [
        { kind: 'run_phase', phase: 'repair' },
      ]);

    case 'thrash_detected':
      if (s.phase !== 'repair') {
        return { ok: false, reason: `thrash_detected is only meaningful in repair, not ${s.phase}` };
      }
      // §9.1: a repeated or oscillating signature means more attempts will not
      // help. Rewind and hand the task back to the planner rather than looping.
      return ok(
        clearGate(
          { ...s, phase: 'plan', status: 'running', planValidationAttempts: 0, signatures: [] },
          'G2',
        ),
        [{ kind: 'rewind_to_task_checkpoint' }, { kind: 'replan' }],
      );

    case 'budget_exhausted': {
      const reason = `budget exhausted: ${trigger.which}`;
      return ok({ ...s, status: 'blocked', blockedReason: reason }, [
        { kind: 'escalate_to_human', reason },
      ]);
    }

    case 'validation_failed': {
      if (s.phase !== 'plan') {
        return { ok: false, reason: `validation_failed is only handled in plan, not ${s.phase}` };
      }
      const attempts = s.planValidationAttempts + 1;
      if (attempts >= PLAN_VALIDATION_LIMIT) {
        return ok({ ...s, planValidationAttempts: attempts, status: 'waiting_human' }, [
          { kind: 'escalate_to_human', reason: `plan failed validation ${attempts}×: ${trigger.rule}` },
        ]);
      }
      // Stay in plan; the planner retries with the failing rule ID in hand.
      return ok({ ...s, planValidationAttempts: attempts }, [{ kind: 'run_phase', phase: 'plan' }]);
    }

    case 'scope_changed': {
      if (s.phase !== 'clarify') {
        return { ok: false, reason: `scope_changed is only handled in clarify, not ${s.phase}` };
      }
      if (s.reSpecCount >= RE_SPEC_LIMIT) {
        return ok({ ...s, status: 'waiting_human' }, [
          { kind: 'escalate_to_human', reason: `re-spec limit (${RE_SPEC_LIMIT}) reached` },
        ]);
      }
      return ok(
        clearGate({ ...s, phase: 'spec', status: 'running', reSpecCount: s.reSpecCount + 1 }, 'G1'),
        [{ kind: 'run_phase', phase: 'spec' }],
      );
    }

    case 'review_findings': {
      if (s.phase !== 'review') {
        return { ok: false, reason: `review_findings is only handled in review, not ${s.phase}` };
      }
      if (trigger.blocking > 0) {
        return ok({ ...s, phase: 'repair', status: 'running' }, [
          { kind: 'run_phase', phase: 'repair' },
        ]);
      }
      return advance(s, opts);
    }

    case 'human_decided': {
      const expected = HUMAN_GATE_AT[s.phase];
      if (expected !== trigger.gate) {
        return { ok: false, reason: `gate ${trigger.gate} cannot be decided in phase ${s.phase}` };
      }
      if (s.status !== 'waiting_human') {
        return { ok: false, reason: `no approval is pending at ${s.phase}` };
      }
      if (trigger.decision === 'reject') {
        return ok({ ...s, status: 'cancelled' }, [{ kind: 'finalize', status: 'cancelled' }]);
      }
      if (trigger.decision === 'revise') {
        const back = revisionTarget(s.phase);
        return ok(clearGate({ ...s, phase: back, status: 'running' }, trigger.gate), [
          { kind: 'run_phase', phase: back },
        ]);
      }
      return advance({ ...s, gatesPassed: [...s.gatesPassed, trigger.gate], status: 'running' }, opts);
    }
  }
}

/** Where a "revise" decision sends the run to regenerate the artifact. */
function revisionTarget(phase: Phase): Phase {
  switch (phase) {
    case 'clarify': return 'spec';
    case 'plan': return 'plan';
    case 'human_review': return 'repair';
    default: return phase;
  }
}

/**
 * A phase's work is complete. If the phase carries a human gate that has not
 * been satisfied for this pass, park the run and request approval; the run
 * only leaves the phase once a human decides.
 */
function advance(s: MachineState, opts: PipelineOptions): TransitionResult {
  const gate = HUMAN_GATE_AT[s.phase];
  if (gate && !s.gatesPassed.includes(gate)) {
    return ok({ ...s, status: 'waiting_human' }, [{ kind: 'request_approval', gate }]);
  }

  const next = nextPhase(s.phase, opts);
  if (!next || next === 'done') {
    return ok({ ...s, phase: 'done', status: 'succeeded' }, [
      { kind: 'finalize', status: 'succeeded' },
    ]);
  }
  return ok({ ...s, phase: next, status: 'running' }, [{ kind: 'run_phase', phase: next }]);
}

function clearGate(s: MachineState, gate: HumanGate): MachineState {
  return { ...s, gatesPassed: s.gatesPassed.filter((g) => g !== gate) };
}

function ok(state: MachineState, effects: Effect[]): TransitionResult {
  return { ok: true, state, effects };
}
