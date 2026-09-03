import { describe, expect, it } from 'vitest';
import { BUILT_IN_WORKFLOWS } from '@agentflow/core';
import type { ResolvedWorkflow } from '@agentflow/protocol';
import { decompose } from './decompose.js';
import { Plan, type Plan as PlanType } from './plan.js';
import { Spec, type Spec as SpecType } from './spec.js';
import type { ContextDigest } from './harvest.js';

const workflow = BUILT_IN_WORKFLOWS.find((w) => w.name === 'feature')! as ResolvedWorkflow;

const spec: SpecType = Spec.parse({
  problem: 'The checkout screen renders a blank panel when the cart is empty.',
  inScope: ['an empty state'], outOfScope: [],
  acceptanceCriteria: [
    { id: 'AC1', statement: 'An empty cart shows an empty state', source: { kind: 'ticket', ref: 'd', quote: 'show an empty state' }, checkable: true },
    { id: 'AC2', statement: 'The button routes to the catalogue', source: { kind: 'ticket', ref: 'd', quote: 'routes to the catalogue' }, checkable: false },
  ],
  affectedSurfaces: { modules: [], apis: [], screens: [], flags: [] },
  assumptions: [], openQuestions: [],
  nonFunctional: { perf: 'n', security: 'n', accessibility: 'n', telemetry: 'n' },
  rollback: 'revert the commit',
});

const digest: ContextDigest = {
  modules: [], entryPoints: [], likelyTouchSet: [],
  conventions: ['components live beside their tests'],
  testLayout: { framework: 'vitest', location: 'colocated' },
  precedent: { found: false, reason: 'greenfield, no precedent' },
  risks: [],
};

const task = (over: Record<string, unknown> = {}) => ({
  id: 'T1', title: 'Add the component', intent: 'Render the empty state when the cart is empty',
  files: ['src/checkout/EmptyState.tsx'], dependsOn: [], satisfies: ['AC1'],
  checks: [{ gate: 'unit', how: 'renders the browse button' }],
  risk: 'low', estimatedEdits: 2, isReproTest: false, ...over,
});

const plan = (tasks: Record<string, unknown>[]): PlanType => Plan.parse({
  strategy: 'Add a component and wire it in.', tasks,
  sequencing: 'component first', testStrategy: { newTests: [], regressionRisk: [] },
  migrations: [], featureFlag: { required: false },
  rollbackPlan: 'revert the commit; additive only', outOfPlanPolicy: 'ask',
});

const run = (tasks: Record<string, unknown>[]) =>
  decompose({ plan: plan(tasks), spec, digest, workflow });

describe('decompose is mechanical (§5 Stage 5)', () => {
  it('emits packets in dependency order', () => {
    const packets = run([
      task({ id: 'T3', dependsOn: ['T2'], satisfies: ['AC2'] }),
      task({ id: 'T1', dependsOn: [] }),
      task({ id: 'T2', dependsOn: ['T1'], satisfies: ['AC2'] }),
    ]);
    expect(packets.map((p) => p.task.id)).toEqual(['T1', 'T2', 'T3']);
  });

  it('is deterministic — the same plan always compiles the same way', () => {
    const tasks = [task({ id: 'T1' }), task({ id: 'T2', dependsOn: ['T1'], satisfies: ['AC2'] })];
    expect(JSON.stringify(run(tasks))).toEqual(JSON.stringify(run(tasks)));
  });

  it('slices the spec to only the criteria this task serves', () => {
    const [p1, p2] = run([task({ id: 'T1', satisfies: ['AC1'] }), task({ id: 'T2', satisfies: ['AC2'] })]);
    expect(p1!.contextSlice.specExcerpt.map((a) => a.id)).toEqual(['AC1']);
    expect(p2!.contextSlice.specExcerpt.map((a) => a.id)).toEqual(['AC2']);
    // Checkability travels with the criterion so the implementer knows which
    // of its criteria a gate can actually decide.
    expect(p2!.contextSlice.specExcerpt[0]!.checkable).toBe(false);
  });

  it('tells each task what earlier tasks already did', () => {
    const packets = run([
      task({ id: 'T1' }),
      task({ id: 'T2', dependsOn: ['T1'], satisfies: ['AC2'] }),
    ]);
    expect(packets[0]!.contextSlice.completed).toEqual([]);
    expect(packets[1]!.contextSlice.completed).toEqual([{ id: 'T1', title: 'Add the component' }]);
  });

  it('carries only the gates the task names, dropping manual', () => {
    const [p] = run([task({
      checks: [
        { gate: 'unit', how: 'renders the browse button' },
        { gate: 'manual', how: 'a human confirms the visual polish' },
        { gate: 'lint', how: 'no unused imports in the new file' },
      ],
    })]);
    expect(p!.gates).toEqual(['unit', 'lint']);
  });
});

describe('packet guardrails are the enforceable form of "stay in scope"', () => {
  it('allows the predicted files and their sibling directory', () => {
    const [p] = run([task({ files: ['src/checkout/EmptyState.tsx'] })]);
    expect(p!.guardrails.allowedPaths).toContain('src/checkout/EmptyState.tsx');
    // A component's test lives beside it and is rarely predicted by name.
    expect(p!.guardrails.allowedPaths).toContain('src/checkout/*');
  });

  it('does not open a sibling module', () => {
    const [p] = run([task({ files: ['src/checkout/EmptyState.tsx'] })]);
    expect(p!.guardrails.allowedPaths.some((g) => g.startsWith('src/billing'))).toBe(false);
  });

  it('always adds the never-writable paths, whatever the workflow says', () => {
    const [p] = run([task()]);
    expect(p!.guardrails.forbiddenPaths).toContain('**/*.pem');
    expect(p!.guardrails.forbiddenPaths).toContain('**/.git/**');
  });

  it('gives the touch budget one file of headroom over the estimate', () => {
    const [p] = run([task({ estimatedEdits: 3 })]);
    expect(p!.guardrails.maxFilesTouched).toBe(4);
  });

  it('never exceeds the workflow ceiling', () => {
    const [p] = run([task({ estimatedEdits: 500 })]);
    expect(p!.guardrails.maxFilesTouched).toBe(workflow.guardrails.maxFilesTouched);
  });

  it('forbids new dependencies when the workflow does', () => {
    const [p] = run([task()]);
    expect(p!.guardrails.maxNewDeps).toBe(0);
  });
});
