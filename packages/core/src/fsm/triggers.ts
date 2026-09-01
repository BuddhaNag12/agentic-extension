import type { GateId, HumanGate, Phase } from '@agentflow/protocol';

/**
 * Everything that can move a run. There is deliberately no trigger meaning
 * "the model said it was done" — §1.4: the model proposes, the runner decides.
 */
export type Trigger =
  /** A phase's mechanical work finished and its machine gate passed. */
  | { kind: 'advance' }
  | { kind: 'gate_passed'; gate: GateId }
  | { kind: 'gate_failed'; gate: GateId }
  /** A phase's own output failed schema/rule validation (e.g. PLAN_VALID). */
  | { kind: 'validation_failed'; rule: string }
  | { kind: 'human_decided'; gate: HumanGate; decision: 'approve' | 'reject' | 'revise' }
  /** Clarify answers materially changed inScope/outOfScope. */
  | { kind: 'scope_changed' }
  /** Repair produced the same or an oscillating failure signature (§9.1). */
  | { kind: 'thrash_detected'; signature: string }
  | { kind: 'budget_exhausted'; which: 'attempts' | 'usd' | 'wallclock' }
  | { kind: 'review_findings'; blocking: number }
  | { kind: 'blocked'; reason: string }
  | { kind: 'cancel' }
  | { kind: 'resume' };

export type TriggerKind = Trigger['kind'];

/** Which phases hand control to a human, and at which gate. */
export const HUMAN_GATE_PHASE: Record<HumanGate, Phase> = {
  G1: 'clarify',
  G2: 'plan',
  G3: 'human_review',
};
