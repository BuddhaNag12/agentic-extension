import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Plan, pathIsPlausible, topoOrder, validatePlan, type Plan as PlanType, type PlanContext } from './plan.js';
import { Spec, type Spec as SpecType } from './spec.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentflow-plan-'));
  mkdirSync(join(root, 'src', 'checkout'), { recursive: true });
  writeFileSync(join(root, 'src', 'checkout', 'Cart.ts'), 'export const cart = 1;\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const spec: SpecType = Spec.parse({
  problem: 'The checkout screen renders a blank panel when the cart is empty.',
  inScope: ['an empty state'],
  outOfScope: [],
  acceptanceCriteria: [
    { id: 'AC1', statement: 'An empty cart shows an empty state', source: { kind: 'ticket', ref: 'description', quote: 'show an empty state' }, checkable: true },
    { id: 'AC2', statement: 'The button routes to the catalogue', source: { kind: 'ticket', ref: 'description', quote: 'routes to the catalogue' }, checkable: true },
  ],
  affectedSurfaces: { modules: ['src/checkout'], apis: [], screens: [], flags: [] },
  assumptions: [], openQuestions: [],
  nonFunctional: { perf: 'none', security: 'none', accessibility: 'none', telemetry: 'none' },
  rollback: 'revert the commit',
});

const task = (over: Record<string, unknown> = {}) => ({
  id: 'T1',
  title: 'Add the empty state component',
  intent: 'Render an empty state when the cart has no items',
  files: ['src/checkout/EmptyState.tsx'],
  dependsOn: [],
  satisfies: ['AC1', 'AC2'],
  checks: [{ gate: 'unit', how: 'EmptyState renders the browse button when items is empty' }],
  risk: 'low',
  estimatedEdits: 2,
  isReproTest: false,
  ...over,
});

const plan = (over: Partial<PlanType> = {}, tasks?: Record<string, unknown>[]): PlanType => Plan.parse({
  strategy: 'Add a component and wire it into the checkout screen.',
  tasks: tasks ?? [task()],
  sequencing: 'component first, then wiring',
  testStrategy: { newTests: [], regressionRisk: [] },
  migrations: [], featureFlag: { required: false },
  rollbackPlan: 'revert the commit; the change is additive',
  outOfPlanPolicy: 'ask',
  ...over,
});

const ctx = (over: Partial<PlanContext> = {}): PlanContext =>
  ({ spec, worktree: root, profile: 'feature', maxEstimatedEdits: 40, ...over });

describe('P2 — the graph must be a DAG', () => {
  it('accepts a well-formed plan', () => {
    expect(validatePlan(plan(), ctx())).toEqual([]);
  });

  it('rejects a dependency on a task that is not in the plan', () => {
    const issues = validatePlan(plan({}, [task({ dependsOn: ['T9'] })]), ctx());
    expect(issues[0]).toMatchObject({ rule: 'P2' });
    expect(issues[0]?.message).toContain('T9');
  });

  it('rejects a self-dependency', () => {
    expect(validatePlan(plan({}, [task({ dependsOn: ['T1'] })]), ctx())[0]?.message).toContain('depends on itself');
  });

  it('finds a cycle rather than hanging', () => {
    const issues = validatePlan(plan({}, [
      task({ id: 'T1', dependsOn: ['T3'] }),
      task({ id: 'T2', dependsOn: ['T1'], satisfies: ['AC1'] }),
      task({ id: 'T3', dependsOn: ['T2'], satisfies: ['AC1'] }),
    ]), ctx());
    expect(issues.some((i) => i.rule === 'P2' && i.message.includes('cycle'))).toBe(true);
  });

  it('accepts a diamond, which is acyclic', () => {
    const issues = validatePlan(plan({}, [
      task({ id: 'T1', satisfies: ['AC1'] }),
      task({ id: 'T2', dependsOn: ['T1'], satisfies: ['AC1'] }),
      task({ id: 'T3', dependsOn: ['T1'], satisfies: ['AC2'] }),
      task({ id: 'T4', dependsOn: ['T2', 'T3'], satisfies: ['AC2'] }),
    ]), ctx());
    expect(issues).toEqual([]);
  });
});

describe('P3 — every task must be machine-checkable', () => {
  it('rejects a task whose checks are all manual', () => {
    const issues = validatePlan(plan({}, [task({ checks: [{ gate: 'manual', how: 'a human looks at it' }] })]), ctx());
    expect(issues[0]).toMatchObject({ rule: 'P3', path: 'T1' });
  });

  it('accepts a task that mixes manual with a real gate', () => {
    const issues = validatePlan(plan({}, [task({
      checks: [{ gate: 'manual', how: 'visual polish' }, { gate: 'unit', how: 'renders the button' }],
    })]), ctx());
    expect(issues).toEqual([]);
  });
});

describe('P4 — coverage runs both ways', () => {
  it('rejects a spec criterion no task serves', () => {
    const issues = validatePlan(plan({}, [task({ satisfies: ['AC1'] })]), ctx());
    expect(issues).toContainEqual(expect.objectContaining({ rule: 'P4', path: 'AC2' }));
  });

  it('rejects a task claiming a criterion the spec does not have', () => {
    const issues = validatePlan(plan({}, [task({ satisfies: ['AC1', 'AC2', 'AC7'] })]), ctx());
    expect(issues.find((i) => i.rule === 'P4' && i.path === 'T1')?.message).toContain('AC7');
  });
});

describe('P5 — predicted paths must be plausible', () => {
  it('accepts an existing file', () => {
    expect(validatePlan(plan({}, [task({ files: ['src/checkout/Cart.ts'] })]), ctx())).toEqual([]);
  });

  it('accepts a new file in a directory that exists', () => {
    expect(validatePlan(plan({}, [task({ files: ['src/checkout/EmptyState.tsx'] })]), ctx())).toEqual([]);
  });

  it('rejects a path under a module that does not exist', () => {
    const issues = validatePlan(plan({}, [task({ files: ['services/billing/Invoice.ts'] })]), ctx());
    expect(issues[0]).toMatchObject({ rule: 'P5' });
  });

  it('rejects a path escaping the worktree', () => {
    expect(pathIsPlausible(root, '../../etc/passwd')).toBe(false);
  });
});

describe('P6 — a bug starts with a failing test', () => {
  const bugCtx = () => ctx({ profile: 'bug' });

  it('rejects a bug plan with no reproduction task', () => {
    const issues = validatePlan(plan(), bugCtx());
    expect(issues.find((i) => i.rule === 'P6')?.message).toContain('reproduction-test task');
  });

  it('accepts a repro test scheduled first', () => {
    const issues = validatePlan(plan({}, [
      task({ id: 'T1', isReproTest: true, satisfies: ['AC1'], files: ['src/checkout/Cart.test.ts'] }),
      task({ id: 'T2', dependsOn: ['T1'], satisfies: ['AC2'] }),
    ]), bugCtx());
    expect(issues).toEqual([]);
  });

  it('rejects a repro test scheduled after the fix', () => {
    const issues = validatePlan(plan({}, [
      task({ id: 'T1', satisfies: ['AC1'] }),
      task({ id: 'T2', dependsOn: ['T1'], isReproTest: true, satisfies: ['AC2'] }),
    ]), bugCtx());
    expect(issues.find((i) => i.rule === 'P6')?.message).toContain('must run first');
  });

  it('rejects a repro test that depends on the fix', () => {
    const issues = validatePlan(plan({}, [
      task({ id: 'T1', isReproTest: true, dependsOn: ['T2'], satisfies: ['AC1'] }),
      task({ id: 'T2', satisfies: ['AC2'] }),
    ]), bugCtx());
    expect(issues.some((i) => i.rule === 'P6' && i.message.includes('must not depend'))).toBe(true);
  });

  it('does not demand a repro test for a feature', () => {
    expect(validatePlan(plan(), ctx({ profile: 'feature' }))).toEqual([]);
  });
});

describe('P7 — over budget, propose a split', () => {
  it('rejects a plan over budget with no split proposed', () => {
    const issues = validatePlan(plan({}, [task({ estimatedEdits: 90 })]), ctx({ maxEstimatedEdits: 40 }));
    expect(issues.find((i) => i.rule === 'P7')?.message).toContain('propose a split');
  });

  it('accepts an over-budget plan that proposes one', () => {
    const issues = validatePlan(
      plan({ proposedSplit: ['ship the component first', 'wire the route in a follow-up'] }, [task({ estimatedEdits: 90 })]),
      ctx({ maxEstimatedEdits: 40 }),
    );
    expect(issues).toEqual([]);
  });
});

describe('topological order', () => {
  it('puts dependencies before dependants', () => {
    const order = topoOrder([
      { ...task({ id: 'T3', dependsOn: ['T1', 'T2'] }) } as never,
      { ...task({ id: 'T1', dependsOn: [] }) } as never,
      { ...task({ id: 'T2', dependsOn: ['T1'] }) } as never,
    ]);
    expect(order.indexOf('T1')).toBeLessThan(order.indexOf('T2'));
    expect(order.indexOf('T2')).toBeLessThan(order.indexOf('T3'));
  });
});

describe('the gate reports everything at once', () => {
  it('collects violations across rules so one retry can fix them all', () => {
    const bad = plan({}, [task({
      id: 'T1', satisfies: ['AC1', 'AC9'], dependsOn: ['T4'],
      checks: [{ gate: 'manual', how: 'someone checks it' }],
      files: ['nowhere/at/all.ts'], estimatedEdits: 99,
    })]);
    const rules = new Set(validatePlan(bad, ctx({ maxEstimatedEdits: 10 })).map((i) => i.rule));
    expect(rules).toEqual(new Set(['P2', 'P3', 'P4', 'P5', 'P7']));
  });
});
