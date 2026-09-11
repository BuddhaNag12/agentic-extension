import type { GateId, HumanGate, Phase, Step } from '@agentflow/protocol';

/**
 * Everything that can move a run. There is deliberately no trigger meaning
 * "the model said it was done" — §1.4: the model proposes, the runner decides.
 */
export type Trigger =
  /** The scheduler gave a queued run a slot. It begins at the step it is
   *  already on, rather than advancing into the next one (DECISIONS D31). */
  | { kind: 'start' }
  /** A step's mechanical work finished and its machine gate passed. */
  | { kind: 'advance' }
  | { kind: 'gate_passed'; gate: GateId }
  | { kind: 'gate_failed'; gate: GateId }
  /** A phase's own output failed schema/rule validation (e.g. PLAN_VALID). */
  | { kind: 'validation_failed'; rule: string }
  | { kind: 'human_decided'; gate: HumanGate; decision: 'approve' | 'reject' | 'revise' }
  /** Answers at G1 materially changed inScope/outOfScope (§5.4). */
  | { kind: 'scope_changed' }
  /** Repair produced the same or an oscillating failure signature (§11.1). */
  | { kind: 'thrash_detected'; signature: string }
  | { kind: 'budget_exhausted'; which: 'attempts' | 'usd' | 'wallclock' }
  | { kind: 'review_findings'; blocking: number }
  | { kind: 'blocked'; reason: string }
  | { kind: 'cancel' }
  | { kind: 'resume' };

export type TriggerKind = Trigger['kind'];

/** Which phases hand control to a human, and at which gate (§5.1). */
export const HUMAN_GATE_PHASE: Record<HumanGate, Phase> = {
  G1: 'context',
  G2: 'plan',
  G3: 'review',
};

/** The step whose exit each gate decides (§5.4, §5.5, §5.7). */
export const HUMAN_GATE_STEP: Record<HumanGate, Step> = {
  G1: 'questions',
  G2: 'validate_plan',
  G3: 'triage_findings',
};
