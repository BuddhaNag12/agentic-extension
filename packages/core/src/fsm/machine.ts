import { PHASE_OF_STEP, type HumanGate, type Phase, type RunStatus, type Step } from '@agentflow/protocol';
import { firstStep, nextPhase, nextStep, type PipelineOptions } from './profiles.js';
import type { Trigger } from './triggers.js';

/**
 * The run state machine (§5, §6.4). Orchestration is code, not a model: every
 * transition here is an ordinary, testable function. Nothing advances because
 * an agent asserted success.
 */

export interface MachineState {
  phase: Phase;
  /** Where inside the phase the run is. Undefined only before intake starts. */
  step?: Step;
  status: RunStatus;
  /** `questions` → `draft_spec` loops. Limit 2 (§5.4). */
  reSpecCount: number;
  /** PLAN_VALID rejections. Limit 3, then escalate to the human (§5.5). */
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
  | { kind: 'run_phase'; phase: Phase; step: Step }
  | { kind: 'run_step'; step: Step }
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

/**
 * Gates are evaluated on exit from these *steps* (§5.4, §5.5, §5.7). Keying on
 * the step rather than the phase matters at G2: `decompose` runs after the
 * plan is approved, so a phase-exit gate would compile work packets from a
 * plan no human had yet seen.
 */
const GATE_AFTER_STEP: Partial<Record<Step, HumanGate>> = {
  questions: 'G1',
  validate_plan: 'G2',
  triage_findings: 'G3',
};

/** The step a run sits in while a human holds it. Only G3 has a name of its
 *  own in §3.1; G1 and G2 park in the step that produced the artifact. */
const PARKED_STEP: Partial<Record<HumanGate, Step>> = {
  G3: 'human_review',
};

/** Where a `revise` decision sends the run to regenerate its artifact. */
const REVISION_STEP: Record<HumanGate, Step> = {
  G1: 'draft_spec',
  G2: 'draft_plan',
  G3: 'repair',
};

const TERMINAL: readonly RunStatus[] = ['failed', 'cancelled', 'succeeded'];

export function initialState(): MachineState {
  return {
    phase: 'intake',
    step: 'classify',
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

/** The gate decided on exit from a step, if any. */
export function gateForStep(step: Step | undefined): HumanGate | undefined {
  return step ? GATE_AFTER_STEP[step] : undefined;
}

/** The gate decided somewhere inside a phase, if any. */
export function gateFor(phase: Phase): HumanGate | undefined {
  for (const [step, gate] of Object.entries(GATE_AFTER_STEP) as [Step, HumanGate][]) {
    if (PHASE_OF_STEP[step] === phase) return gate;
  }
  return undefined;
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
      const step = s.step ?? firstStep(s.phase, opts);
      if (!step) return { ok: false, reason: `phase ${s.phase} has no runnable step` };
      return ok({ ...rest, step, status: 'running' }, [{ kind: 'run_step', step }]);
    }

    case 'start': {
      if (s.status !== 'queued') {
        return { ok: false, reason: `cannot start a run that is ${s.status}` };
      }
      const step = s.step ?? firstStep(s.phase, opts);
      if (!step) return { ok: false, reason: `phase ${s.phase} has no runnable step` };
      // Deliberately not an advance: the first step has to *run*, and the
      // phase it belongs to is where the worktree is created (DECISIONS D31).
      return ok({ ...s, step, status: 'running' }, [{ kind: 'run_step', step }]);
    }

    case 'advance':
      return advance(s, opts);

    case 'gate_passed':
      if (s.step !== 'verify') {
        return { ok: false, reason: `gate_passed is only meaningful in verify, not ${s.step ?? s.phase}` };
      }
      // All gates green. The repair budget is per task, so it resets here.
      return advance({ ...s, repairAttempts: 0, signatures: [] }, opts);

    case 'gate_failed':
      if (s.phase !== 'build') {
        return { ok: false, reason: `gate_failed is not expected in ${s.phase}` };
      }
      return ok({ ...s, step: 'repair', status: 'running' }, [{ kind: 'run_step', step: 'repair' }]);

    case 'thrash_detected':
      if (s.step !== 'repair') {
        return { ok: false, reason: `thrash_detected is only meaningful in repair, not ${s.step ?? s.phase}` };
      }
      // §11.1: a repeated or oscillating signature means more attempts will not
      // help. Rewind and hand the task back to the planner rather than looping.
      return ok(
        clearGate(
          {
            ...s, phase: 'plan', step: 'draft_plan', status: 'running',
            planValidationAttempts: 0, signatures: [],
          },
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
      return ok({ ...s, planValidationAttempts: attempts, step: 'draft_plan' }, [
        { kind: 'run_step', step: 'draft_plan' },
      ]);
    }

    case 'scope_changed': {
      if (s.phase !== 'context') {
        return { ok: false, reason: `scope_changed is only handled in context, not ${s.phase}` };
      }
      if (s.reSpecCount >= RE_SPEC_LIMIT) {
        return ok({ ...s, status: 'waiting_human' }, [
          { kind: 'escalate_to_human', reason: `re-spec limit (${RE_SPEC_LIMIT}) reached` },
        ]);
      }
      return ok(
        clearGate(
          { ...s, step: 'draft_spec', status: 'running', reSpecCount: s.reSpecCount + 1 },
          'G1',
        ),
        [{ kind: 'run_step', step: 'draft_spec' }],
      );
    }

    case 'review_findings': {
      if (s.phase !== 'review') {
        return { ok: false, reason: `review_findings is only handled in review, not ${s.phase}` };
      }
      if (trigger.blocking > 0) {
        // Blocking findings become repair work, so the run goes back to build
        // rather than asking a human to wave them through.
        return ok(clearGate({ ...s, phase: 'build', step: 'repair', status: 'running' }, 'G3'), [
          { kind: 'run_phase', phase: 'build', step: 'repair' },
        ]);
      }
      return advance(s, opts);
    }

    case 'human_decided': {
      if (gateFor(s.phase) !== trigger.gate) {
        return { ok: false, reason: `gate ${trigger.gate} cannot be decided in phase ${s.phase}` };
      }
      if (s.status !== 'waiting_human') {
        return { ok: false, reason: `no approval is pending at ${s.phase}` };
      }
      if (trigger.decision === 'reject') {
        return ok({ ...s, status: 'cancelled' }, [{ kind: 'finalize', status: 'cancelled' }]);
      }
      if (trigger.decision === 'revise') {
        const step = REVISION_STEP[trigger.gate];
        const phase = PHASE_OF_STEP[step];
        return ok(clearGate({ ...s, phase, step, status: 'running' }, trigger.gate), [
          { kind: 'run_phase', phase, step },
        ]);
      }
      // The approval is recorded before advancing, so the gate the run is
      // parked on is satisfied and `advance` walks past it rather than
      // re-requesting the decision that was just made.
      return advance(
        { ...s, gatesPassed: [...s.gatesPassed, trigger.gate], status: 'running' },
        opts,
      );
    }
  }
}

/**
 * A step's work is complete. If the step carries a human gate that has not
 * been satisfied for this pass, park the run and request approval; the run
 * only leaves the step once a human decides. Otherwise walk to the next step,
 * and only when a phase's steps are exhausted to the next phase.
 */
function advance(s: MachineState, opts: PipelineOptions): TransitionResult {
  const gate = s.step ? GATE_AFTER_STEP[s.step] : undefined;
  if (gate && !s.gatesPassed.includes(gate)) {
    const parked = PARKED_STEP[gate];
    return ok(
      { ...s, ...(parked ? { step: parked } : {}), status: 'waiting_human' },
      [{ kind: 'request_approval', gate }],
    );
  }

  const step = nextStep(s.phase, s.step, opts);
  if (step) return ok({ ...s, step, status: 'running' }, [{ kind: 'run_step', step }]);

  const entry = nextRunnablePhase(s.phase, opts);
  // A run ends at its last phase with a terminal status; there is no `done`
  // phase to fall into.
  if (!entry) return ok({ ...s, status: 'succeeded' }, [{ kind: 'finalize', status: 'succeeded' }]);

  return ok({ ...s, phase: entry.phase, step: entry.step, status: 'running' }, [
    { kind: 'run_phase', phase: entry.phase, step: entry.step },
  ]);
}

/**
 * The next phase that actually has work. A phase left in the pipeline whose
 * every step is individually skipped is walked past rather than entered — a
 * run parked in a phase with nothing to run would never emit a trigger.
 */
function nextRunnablePhase(
  from: Phase,
  opts: PipelineOptions,
): { phase: Phase; step: Step } | undefined {
  let phase = nextPhase(from, opts);
  while (phase) {
    const step = firstStep(phase, opts);
    if (step) return { phase, step };
    phase = nextPhase(phase, opts);
  }
  return undefined;
}

function clearGate(s: MachineState, gate: HumanGate): MachineState {
  return { ...s, gatesPassed: s.gatesPassed.filter((g) => g !== gate) };
}

function ok(state: MachineState, effects: Effect[]): TransitionResult {
  return { ok: true, state, effects };
}
