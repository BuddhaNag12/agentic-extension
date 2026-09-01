import { describe, expect, it } from 'vitest';
import type { PipelineOptions } from './profiles.js';
import { PLAN_VALIDATION_LIMIT, RE_SPEC_LIMIT, initialState, transition, type MachineState } from './machine.js';
import type { Trigger } from './triggers.js';

const feature: PipelineOptions = { profile: 'feature', waitForCi: false };
const chore: PipelineOptions = { profile: 'chore', waitForCi: false };
const spike: PipelineOptions = { profile: 'spike', waitForCi: false };

/** Drive the machine, asserting every step is legal. */
function drive(state: MachineState, triggers: Trigger[], opts = feature): MachineState {
  let s = state;
  for (const t of triggers) {
    const r = transition(s, t, opts);
    if (!r.ok) throw new Error(`illegal ${t.kind} in ${s.phase}: ${r.reason}`);
    s = r.state;
  }
  return s;
}

const approve = (gate: 'G1' | 'G2' | 'G3'): Trigger =>
  ({ kind: 'human_decided', gate, decision: 'approve' });

describe('happy path', () => {
  it('walks a feature ticket to succeeded through exactly three gates', () => {
    const s = drive(initialState(), [
      { kind: 'advance' }, // intake  → harvest
      { kind: 'advance' }, // harvest → spec
      { kind: 'advance' }, // spec    → clarify
      { kind: 'advance' }, // clarify work done → parks for G1
      approve('G1'),
      { kind: 'advance' }, // plan work done → parks for G2
      approve('G2'),
      { kind: 'advance' }, // decompose → implement
      { kind: 'advance' }, // implement → verify
      { kind: 'gate_passed', gate: 'unit' },
      { kind: 'review_findings', blocking: 0 },
      { kind: 'advance' }, // human_review assembled → parks for G3
      approve('G3'),
      { kind: 'advance' }, // ship → done
    ]);
    expect(s.phase).toBe('done');
    expect(s.status).toBe('succeeded');
    expect(s.gatesPassed).toEqual(['G1', 'G2', 'G3']);
  });

  it('parks at each gate rather than advancing on its own', () => {
    const atClarify = drive(initialState(), [
      { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' },
    ]);
    expect(atClarify.phase).toBe('clarify');
    expect(atClarify.status).toBe('waiting_human');
  });

  it('emits request_approval when a gated phase finishes its work', () => {
    const atClarify = drive(initialState(), [{ kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' }]);
    const r = transition(atClarify, { kind: 'advance' }, feature);
    expect(r.ok && r.effects).toContainEqual({ kind: 'request_approval', gate: 'G1' });
  });
});

describe('profiles (§5.10)', () => {
  it('chore skips clarify and its gate', () => {
    const s = drive(initialState(), [{ kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' }], chore);
    expect(s.phase).toBe('plan');
  });

  it('forceClarify pulls the gate back in when a blocking question appears', () => {
    const opts: PipelineOptions = { ...chore, forceClarify: true };
    const s = drive(initialState(), [{ kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' }], opts);
    expect(s.phase).toBe('clarify');
  });

  it('spike reaches done without ever entering implement, verify or ship', () => {
    const visited: string[] = [];
    let s = initialState();
    const steps: Trigger[] = [
      { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' },
      { kind: 'advance' }, approve('G1'),
      { kind: 'advance' }, approve('G2'),
      { kind: 'advance' }, { kind: 'advance' }, approve('G3'),
    ];
    for (const step of steps) {
      s = drive(s, [step], spike);
      visited.push(s.phase);
    }
    expect(s.phase).toBe('done');
    expect(s.status).toBe('succeeded');
    expect(visited).not.toContain('implement');
    expect(visited).not.toContain('verify');
    expect(visited).not.toContain('ship');
    // A spike still gets all three gates: its deliverable is the document.
    expect(s.gatesPassed).toEqual(['G1', 'G2', 'G3']);
  });
});

describe('the invariant: no phase advances on assertion (§1.4)', () => {
  it('rejects a gate decision for a gate that is not pending', () => {
    const r = transition(initialState(), approve('G1'), feature);
    expect(r.ok).toBe(false);
  });

  it('rejects gate_passed outside verify', () => {
    const r = transition(initialState(), { kind: 'gate_passed', gate: 'unit' }, feature);
    expect(r.ok).toBe(false);
  });

  it('rejects a decision for the wrong gate at a pending gate', () => {
    const atClarify = drive(initialState(), [
      { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' },
    ]);
    const r = transition(atClarify, approve('G2'), feature);
    expect(r.ok).toBe(false);
  });

  it('refuses every trigger once terminal', () => {
    const cancelled = drive(initialState(), [{ kind: 'cancel' }]);
    for (const t of [{ kind: 'advance' } as const, { kind: 'resume' } as const]) {
      expect(transition(cancelled, t, feature).ok).toBe(false);
    }
  });
});

describe('loop-backs invalidate their gate', () => {
  it('re-gates G1 after a scope change forces a re-spec', () => {
    const atClarify = drive(initialState(), [
      { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' },
      approve('G1'),
    ]);
    expect(atClarify.gatesPassed).toContain('G1');

    // Approving G1 moved us to plan; walk a fresh run back through clarify.
    const looped = drive(initialState(), [
      { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' },
      { kind: 'scope_changed' },
    ]);
    expect(looped.phase).toBe('spec');
    expect(looped.gatesPassed).not.toContain('G1');
    expect(looped.reSpecCount).toBe(1);
  });

  it('escalates instead of looping forever on re-spec', () => {
    let s = drive(initialState(), [{ kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' }]);
    for (let i = 0; i < RE_SPEC_LIMIT; i += 1) {
      s = drive(s, [{ kind: 'scope_changed' }, { kind: 'advance' }]);
    }
    expect(s.reSpecCount).toBe(RE_SPEC_LIMIT);
    const r = transition(s, { kind: 'scope_changed' }, feature);
    expect(r.ok && r.state.status).toBe('waiting_human');
    expect(r.ok && r.effects[0]?.kind).toBe('escalate_to_human');
  });

  it('re-gates G3 when the human requests changes', () => {
    const atG3 = drive(initialState(), [
      { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' },
      approve('G1'), { kind: 'advance' }, approve('G2'),
      { kind: 'advance' }, { kind: 'advance' },
      { kind: 'gate_passed', gate: 'unit' },
      { kind: 'review_findings', blocking: 0 },
      { kind: 'advance' },
    ]);
    const revised = drive(atG3, [{ kind: 'human_decided', gate: 'G3', decision: 'revise' }]);
    expect(revised.phase).toBe('repair');
    expect(revised.gatesPassed).not.toContain('G3');
  });
});

describe('plan validation (§5 Stage 4)', () => {
  it('retries in place, then escalates with the failing rule', () => {
    let s = drive(initialState(), [
      { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' },
      approve('G1'),
    ]);
    expect(s.phase).toBe('plan');
    for (let i = 1; i < PLAN_VALIDATION_LIMIT; i += 1) {
      s = drive(s, [{ kind: 'validation_failed', rule: 'RULE_3' }]);
      expect(s.phase).toBe('plan');
      expect(s.status).not.toBe('waiting_human');
    }
    const r = transition(s, { kind: 'validation_failed', rule: 'RULE_3' }, feature);
    expect(r.ok && r.state.status).toBe('waiting_human');
    expect(r.ok && r.effects[0]).toMatchObject({ kind: 'escalate_to_human' });
  });
});

describe('repair loop (§9)', () => {
  const atVerify = () => drive(initialState(), [
    { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' }, { kind: 'advance' },
    approve('G1'), { kind: 'advance' }, approve('G2'),
    { kind: 'advance' }, { kind: 'advance' },
  ]);

  it('sends a failed gate to repair', () => {
    const s = drive(atVerify(), [{ kind: 'gate_failed', gate: 'unit' }]);
    expect(s.phase).toBe('repair');
  });

  it('thrash rewinds and replans rather than burning another attempt', () => {
    const s = drive(atVerify(), [{ kind: 'gate_failed', gate: 'unit' }]);
    const r = transition(s, { kind: 'thrash_detected', signature: 'abc' }, feature);
    expect(r.ok && r.state.phase).toBe('plan');
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
    const s = drive(atVerify(), [{ kind: 'gate_failed', gate: 'unit' }]);
    const withHistory = { ...s, phase: 'verify' as const, repairAttempts: 3, signatures: ['a', 'b'] };
    const r = transition(withHistory, { kind: 'gate_passed', gate: 'unit' }, feature);
    expect(r.ok && r.state.repairAttempts).toBe(0);
    expect(r.ok && r.state.signatures).toEqual([]);
  });

  it('sends blocking review findings back to repair', () => {
    const s = drive(atVerify(), [
      { kind: 'gate_passed', gate: 'unit' },
    ]);
    expect(s.phase).toBe('review');
    const r = transition(s, { kind: 'review_findings', blocking: 2 }, feature);
    expect(r.ok && r.state.phase).toBe('repair');
  });
});

describe('blocked and resume', () => {
  it('resumes a blocked run back into its phase', () => {
    const s = drive(initialState(), [{ kind: 'advance' }, { kind: 'blocked', reason: 'auth expired' }]);
    expect(s.status).toBe('blocked');
    const r = transition(s, { kind: 'resume' }, feature);
    expect(r.ok && r.state.status).toBe('running');
    expect(r.ok && r.state.blockedReason).toBeUndefined();
    expect(r.ok && r.effects).toEqual([{ kind: 'run_phase', phase: 'harvest' }]);
  });

  it('refuses to resume a run that is merely running', () => {
    const s = drive(initialState(), [{ kind: 'advance' }]);
    expect(transition(s, { kind: 'resume' }, feature).ok).toBe(false);
  });
});
