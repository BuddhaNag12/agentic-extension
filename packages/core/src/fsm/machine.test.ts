import { describe, expect, it } from 'vitest';
import { pipelineOptionsFor, plannedSteps, type PipelineOptions } from './profiles.js';
import { PLAN_VALIDATION_LIMIT, RE_SPEC_LIMIT, initialState, transition, type MachineState } from './machine.js';
import type { Trigger } from './triggers.js';
import { BUILT_IN_WORKFLOWS } from '../workflow/builtins.js';

const optionsFor = (name: string): PipelineOptions =>
  pipelineOptionsFor(BUILT_IN_WORKFLOWS.find((w) => w.name === name)!);

const feature = optionsFor('feature');
const spike = optionsFor('spike');

/**
 * A pipeline that genuinely omits the `questions` step, to exercise the skip
 * path. No *workflow* may express this while still requiring G1 — W8 rejects
 * it — but the machine has to handle the shape.
 */
const noQuestions: PipelineOptions = { skip: [], skipSteps: ['questions'], waitForCi: false };

/** Drive the machine, asserting every transition is legal. */
function drive(state: MachineState, triggers: Trigger[], opts = feature): MachineState {
  let s = state;
  for (const t of triggers) {
    const r = transition(s, t, opts);
    if (!r.ok) throw new Error(`illegal ${t.kind} at ${s.phase}/${s.step}: ${r.reason}`);
    s = r.state;
  }
  return s;
}

const approve = (gate: 'G1' | 'G2' | 'G3'): Trigger =>
  ({ kind: 'human_decided', gate, decision: 'approve' });

const advance: Trigger = { kind: 'advance' };
const advances = (n: number): Trigger[] => Array.from({ length: n }, () => advance);

/**
 * Walk to the given step, so a test never hard-codes a trigger count. Gates
 * along the way are approved and verify is reported green — a test that wants
 * to examine a gate or a red gate drives there itself.
 */
function driveTo(step: string, opts = feature): MachineState {
  let s = initialState();
  for (let i = 0; i < 60; i += 1) {
    if (s.step === step) return s;
    if (s.status === 'waiting_human') {
      const gate = (['G1', 'G2', 'G3'] as const).find((g) => !s.gatesPassed.includes(g));
      if (!gate) throw new Error(`parked at ${s.phase}/${s.step} with every gate passed`);
      s = drive(s, [approve(gate)], opts);
      continue;
    }
    s = drive(s, [s.step === 'verify' ? { kind: 'gate_passed', gate: 'unit' } : advance], opts);
  }
  throw new Error(`never reached ${step}`);
}

describe('the seven phases (§5.1)', () => {
  it('walks a feature ticket to succeeded through exactly three gates', () => {
    const s = drive(initialState(), [
      ...advances(9),      // classify → … → questions
      advance,             // questions done → parks for G1
      approve('G1'),       // → draft_plan
      advance,             // → validate_plan
      advance,             // → parks for G2
      approve('G2'),       // → decompose
      advance,             // → implement
      advance,             // → verify
      { kind: 'gate_passed', gate: 'unit' },
      { kind: 'review_findings', blocking: 0 },
      advance,             // triage_findings done → parks for G3
      approve('G3'),       // → ship
      advance,             // ship prepared → done
    ]);
    expect(s.phase).toBe('ship');
    expect(s.status).toBe('succeeded');
    expect(s.gatesPassed).toEqual(['G1', 'G2', 'G3']);
  });

  it('visits every phase in §5.1 order and nothing else', () => {
    const visited: string[] = [];
    let s = initialState();
    const script: Trigger[] = [
      ...advances(10), approve('G1'),
      advance, advance, approve('G2'),
      advance, advance,
      { kind: 'gate_passed', gate: 'unit' },
      { kind: 'review_findings', blocking: 0 },
      advance, approve('G3'), advance,
    ];
    for (const t of script) {
      s = drive(s, [t]);
      if (visited.at(-1) !== s.phase) visited.push(s.phase);
    }
    expect(visited).toEqual(['intake', 'preflight', 'context', 'plan', 'build', 'review', 'ship']);
  });

  it('there is no terminal phase — a finished run sits at ship, succeeded', () => {
    const s = drive(initialState(), [
      ...advances(10), approve('G1'),
      advance, advance, approve('G2'),
      advance, advance,
      { kind: 'gate_passed', gate: 'unit' },
      { kind: 'review_findings', blocking: 0 },
      advance, approve('G3'), advance,
    ]);
    expect(s.phase).toBe('ship');
    expect(s.status).toBe('succeeded');
  });

  it('parks at each gate rather than advancing on its own', () => {
    const atG1 = drive(driveTo('questions'), [advance]);
    expect(atG1.phase).toBe('context');
    expect(atG1.status).toBe('waiting_human');
  });

  it('emits request_approval when a gated step finishes its work', () => {
    const r = transition(driveTo('questions'), advance, feature);
    expect(r.ok && r.effects).toContainEqual({ kind: 'request_approval', gate: 'G1' });
  });

  it('parks G3 in the human_review step, which is what the run is doing', () => {
    const atTriage = drive(driveTo('verify'), [
      { kind: 'gate_passed', gate: 'unit' },
      { kind: 'review_findings', blocking: 0 },
    ]);
    expect(atTriage.step).toBe('triage_findings');
    const parked = drive(atTriage, [advance]);
    expect(parked.step).toBe('human_review');
    expect(parked.status).toBe('waiting_human');
  });
});

describe('steps sit inside phases (§3.1)', () => {
  it('gates G2 before decompose, so packets come from an approved plan', () => {
    const atG2 = drive(driveTo('validate_plan'), [advance]);
    expect(atG2.status).toBe('waiting_human');
    expect(atG2.step).toBe('validate_plan');

    const approved = drive(atG2, [approve('G2')]);
    expect(approved.step).toBe('decompose');
    expect(approved.phase).toBe('plan');
  });

  it('a step advance stays inside the phase', () => {
    const r = transition(driveTo('harvest'), advance, feature);
    expect(r.ok && r.state.phase).toBe('context');
    expect(r.ok && r.state.step).toBe('draft_spec');
    expect(r.ok && r.effects).toEqual([{ kind: 'run_step', step: 'draft_spec' }]);
  });

  it('the last step of a phase enters the next phase at its first step', () => {
    const r = transition(driveTo('baseline_gates'), advance, feature);
    expect(r.ok && r.effects).toEqual([
      { kind: 'run_phase', phase: 'context', step: 'harvest' },
    ]);
  });

  it('ship stops before push unless autoPush is on (§5.8)', () => {
    expect(plannedSteps(feature)).toContain('rebase');
    expect(plannedSteps(feature)).not.toContain('push');
    expect(plannedSteps({ ...feature, autoPush: true })).toContain('push');
  });
});

describe('profiles (§5.9)', () => {
  it('a pipeline that omits the questions step goes straight to plan', () => {
    const s = drive(driveTo('draft_spec', noQuestions), [advance], noQuestions);
    expect(s.phase).toBe('plan');
    expect(s.step).toBe('draft_plan');
  });

  it('forceQuestions pulls the step back in when a blocking question appears', () => {
    const opts: PipelineOptions = { ...noQuestions, forceQuestions: true };
    const s = drive(driveTo('draft_spec', opts), [advance], opts);
    expect(s.step).toBe('questions');
  });

  it('chore keeps the questions step and G1 — it skips the questions, not the gate', () => {
    const chore = BUILT_IN_WORKFLOWS.find((w) => w.name === 'chore')!;
    expect(chore.pipeline.skipSteps).not.toContain('questions');
    expect(chore.hitl.gates).toEqual(['G1', 'G2', 'G3']);
    expect(chore.hitl.maxQuestionsPerPhase).toBe(0);
  });

  it('spike succeeds without ever entering build or ship, and keeps all three gates', () => {
    const visited: string[] = [];
    let s = initialState();
    const script: Trigger[] = [
      ...advances(10), approve('G1'),
      advance, advance, approve('G2'),
      advance, advance, approve('G3'),
    ];
    for (const t of script) {
      s = drive(s, [t], spike);
      visited.push(s.phase);
    }
    expect(s.status).toBe('succeeded');
    expect(visited).not.toContain('build');
    expect(visited).not.toContain('ship');
    // A spike still gets all three gates: its deliverable is the document, and
    // G3's question becomes "are these findings good?" (DECISIONS D11).
    expect(s.gatesPassed).toEqual(['G1', 'G2', 'G3']);
  });

  it('spike skips auto_review but keeps the review phase that carries G3', () => {
    expect(plannedSteps(spike)).not.toContain('auto_review');
    expect(plannedSteps(spike)).toContain('triage_findings');
  });
});

describe('the invariant: nothing advances on assertion (§1.4)', () => {
  it('rejects a gate decision for a gate that is not pending', () => {
    expect(transition(initialState(), approve('G1'), feature).ok).toBe(false);
  });

  it('rejects gate_passed outside verify', () => {
    expect(transition(initialState(), { kind: 'gate_passed', gate: 'unit' }, feature).ok).toBe(false);
    expect(transition(driveTo('harvest'), { kind: 'gate_passed', gate: 'unit' }, feature).ok).toBe(false);
  });

  it('rejects a decision for the wrong gate at a pending gate', () => {
    const atG1 = drive(driveTo('questions'), [advance]);
    expect(transition(atG1, approve('G2'), feature).ok).toBe(false);
  });

  it('refuses every trigger once terminal', () => {
    const cancelled = drive(initialState(), [{ kind: 'cancel' }]);
    for (const t of [advance, { kind: 'resume' } as const]) {
      expect(transition(cancelled, t, feature).ok).toBe(false);
    }
  });
});

describe('loop-backs invalidate their gate', () => {
  it('re-gates G1 after a scope change forces a re-spec', () => {
    const approved = drive(driveTo('questions'), [advance, approve('G1')]);
    expect(approved.gatesPassed).toContain('G1');

    const looped = drive(driveTo('questions'), [{ kind: 'scope_changed' }]);
    expect(looped.phase).toBe('context');
    expect(looped.step).toBe('draft_spec');
    expect(looped.gatesPassed).not.toContain('G1');
    expect(looped.reSpecCount).toBe(1);
  });

  it('escalates instead of looping forever on re-spec', () => {
    let s = driveTo('questions');
    for (let i = 0; i < RE_SPEC_LIMIT; i += 1) {
      s = drive(s, [{ kind: 'scope_changed' }, advance]);
    }
    expect(s.reSpecCount).toBe(RE_SPEC_LIMIT);
    const r = transition(s, { kind: 'scope_changed' }, feature);
    expect(r.ok && r.state.status).toBe('waiting_human');
    expect(r.ok && r.effects[0]?.kind).toBe('escalate_to_human');
  });

  it('re-gates G3 when the human requests changes', () => {
    const atG3 = drive(driveTo('verify'), [
      { kind: 'gate_passed', gate: 'unit' },
      { kind: 'review_findings', blocking: 0 },
      advance,
    ]);
    const revised = drive(atG3, [{ kind: 'human_decided', gate: 'G3', decision: 'revise' }]);
    expect(revised.phase).toBe('build');
    expect(revised.step).toBe('repair');
    expect(revised.gatesPassed).not.toContain('G3');
  });
});

describe('plan validation (§5.5)', () => {
  it('retries in place, then escalates with the failing rule', () => {
    let s = drive(driveTo('questions'), [advance, approve('G1')]);
    expect(s.step).toBe('draft_plan');
    for (let i = 1; i < PLAN_VALIDATION_LIMIT; i += 1) {
      s = drive(s, [{ kind: 'validation_failed', rule: 'RULE_3' }]);
      expect(s.step).toBe('draft_plan');
      expect(s.status).not.toBe('waiting_human');
    }
    const r = transition(s, { kind: 'validation_failed', rule: 'RULE_3' }, feature);
    expect(r.ok && r.state.status).toBe('waiting_human');
    expect(r.ok && r.effects[0]).toMatchObject({ kind: 'escalate_to_human' });
  });
});

describe('repair loop (§11)', () => {
  const atVerify = () => driveTo('verify');

  it('sends a failed gate to the repair step, still inside build', () => {
    const s = drive(atVerify(), [{ kind: 'gate_failed', gate: 'unit' }]);
    expect(s.phase).toBe('build');
    expect(s.step).toBe('repair');
  });

  it('hands a repaired tree back to verify, never onward to review', () => {
    const repaired = drive(atVerify(), [{ kind: 'gate_failed', gate: 'unit' }, advance]);
    expect(repaired.step).toBe('verify');
    expect(repaired.phase).toBe('build');
  });

  it('thrash rewinds and replans rather than burning another attempt', () => {
    const s = drive(atVerify(), [{ kind: 'gate_failed', gate: 'unit' }]);
    const r = transition(s, { kind: 'thrash_detected', signature: 'abc' }, feature);
    expect(r.ok && r.state.phase).toBe('plan');
    expect(r.ok && r.state.step).toBe('draft_plan');
    expect(r.ok && r.effects).toEqual([{ kind: 'rewind_to_task_checkpoint' }, { kind: 'replan' }]);
    // The plan must be re-approved: it is a different plan now.
    expect(r.ok && r.state.gatesPassed).not.toContain('G2');
  });

  it('blocks on budget exhaustion instead of continuing', () => {
    const s = drive(atVerify(), [{ kind: 'gate_failed', gate: 'unit' }]);
    const r = transition(s, { kind: 'budget_exhausted', which: 'usd' }, feature);
    expect(r.ok && r.state.status).toBe('blocked');
    expect(r.ok && r.state.blockedReason).toContain('usd');
  });

  it('resets the per-task repair budget once gates go green', () => {
    const withHistory = { ...atVerify(), repairAttempts: 3, signatures: ['a', 'b'] };
    const r = transition(withHistory, { kind: 'gate_passed', gate: 'unit' }, feature);
    expect(r.ok && r.state.repairAttempts).toBe(0);
    expect(r.ok && r.state.signatures).toEqual([]);
  });

  it('sends blocking review findings back to build, and re-gates G3', () => {
    const s = drive(atVerify(), [{ kind: 'gate_passed', gate: 'unit' }]);
    expect(s.phase).toBe('review');
    const r = transition(s, { kind: 'review_findings', blocking: 2 }, feature);
    expect(r.ok && r.state.phase).toBe('build');
    expect(r.ok && r.state.step).toBe('repair');
    expect(r.ok && r.state.gatesPassed).not.toContain('G3');
  });
});

describe('blocked and resume', () => {
  it('resumes a blocked run back into its step', () => {
    const s = drive(initialState(), [advance, { kind: 'blocked', reason: 'auth expired' }]);
    expect(s.status).toBe('blocked');
    const r = transition(s, { kind: 'resume' }, feature);
    expect(r.ok && r.state.status).toBe('running');
    expect(r.ok && r.state.blockedReason).toBeUndefined();
    expect(r.ok && r.effects).toEqual([{ kind: 'run_step', step: 'map_repo' }]);
  });

  it('refuses to resume a run that is merely running', () => {
    const s = drive(initialState(), [advance]);
    expect(transition(s, { kind: 'resume' }, feature).ok).toBe(false);
  });
});

describe('a pipeline that declares fewer gates (§7)', () => {
  const review = optionsFor('pr-review');

  it('does not park at a gate the workflow never declared', () => {
    // The machine used to assume all three, so a review run would have stopped
    // at G1 to show a human a specification that does not exist.
    let s = initialState();
    for (let i = 0; i < 20 && s.status !== 'waiting_human'; i += 1) {
      s = drive(s, [s.step === 'auto_review' ? { kind: 'review_findings', blocking: 0 } : advance], review);
    }
    expect(s.status).toBe('waiting_human');
    expect(s.step).toBe('human_review');
    expect(s.gatesPassed).toEqual([]);
  });

  it('still ends at G3 — no pipeline finishes without a human', () => {
    let s = initialState();
    for (let i = 0; i < 20 && s.status !== 'waiting_human'; i += 1) {
      s = drive(s, [s.step === 'auto_review' ? { kind: 'review_findings', blocking: 0 } : advance], review);
    }
    const done = drive(s, [approve('G3')], review);
    expect(done.status).toBe('succeeded');
    expect(done.gatesPassed).toEqual(['G3']);
  });

  it('never reaches build or ship', () => {
    const visited: string[] = [];
    let s = initialState();
    for (let i = 0; i < 20 && s.status !== 'waiting_human'; i += 1) {
      s = drive(s, [s.step === 'auto_review' ? { kind: 'review_findings', blocking: 0 } : advance], review);
      visited.push(s.phase);
    }
    expect(visited).not.toContain('build');
    expect(visited).not.toContain('ship');
    expect(visited).toContain('context');
  });
});
