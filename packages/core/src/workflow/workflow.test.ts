import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as toYaml } from 'yaml';
import { DEFAULT_POLICY, OrgPolicy, WorkflowDefinition, type OrgPolicy as Policy } from '@agentflow/protocol';
import { BUILT_IN_WORKFLOWS } from './builtins.js';
import { loadWorkflows, seedBuiltIns } from './loader.js';
import { validateWorkflow } from './validate.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentflow-wf-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const known = new Set(BUILT_IN_WORKFLOWS.map((w) => w.name));
const wf = (over: Record<string, unknown> = {}) =>
  WorkflowDefinition.parse({ name: 'test', ...over });

const write = (name: string, def: Record<string, unknown>) => {
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'workflows', `${name}.yaml`), toYaml({ name, ...def }), 'utf8');
};
const writePolicy = (p: Partial<Policy>) =>
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(OrgPolicy.parse(p)), 'utf8');

describe('built-in workflows', () => {
  it('all validate against the default policy', () => {
    for (const builtin of BUILT_IN_WORKFLOWS) {
      expect(validateWorkflow(builtin, DEFAULT_POLICY, known), builtin.name).toEqual([]);
    }
  });

  it('seed to disk once and are not overwritten afterwards', () => {
    const first = seedBuiltIns(join(dir, 'workflows'));
    expect(first).toHaveLength(BUILT_IN_WORKFLOWS.length);
    expect(seedBuiltIns(join(dir, 'workflows'))).toEqual([]);
  });

  it('bind a cheaper model to triage than to review', () => {
    const feature = BUILT_IN_WORKFLOWS.find((w) => w.name === 'feature')!;
    expect(feature.agents.triage?.model).toBe('haiku');
    expect(feature.agents.reviewer?.model).toBe('opus');
  });
});

describe('W3 — model aliases', () => {
  it('blocks an alias missing from the catalogue rather than rejecting the file', () => {
    // The schema enum rejects a bad alias before this runs; the guard exists
    // for enum/catalogue drift, so exercise it directly.
    const drifted = { ...wf(), agents: { implementer: { model: 'gpt', effort: 'high', thinking: 'adaptive' } } };
    const issues = validateWorkflow(drifted as never, DEFAULT_POLICY, known);
    expect(issues).toContainEqual(expect.objectContaining({ rule: 'W3', severity: 'block' }));
  });

  it('rejects an unknown alias at the schema layer', () => {
    expect(() => wf({ agents: { implementer: { model: 'gpt' } } })).toThrow();
  });

  it('blocks a model the org policy forbids', () => {
    const policy = OrgPolicy.parse({ forbiddenModels: ['fable'] });
    const issues = validateWorkflow(wf({ agents: { reviewer: { model: 'fable' } } }), policy, known);
    expect(issues).toContainEqual(expect.objectContaining({ rule: 'W3', severity: 'block' }));
  });

  it('blocks a forbidden escalation target too', () => {
    const policy = OrgPolicy.parse({ forbiddenModels: ['fable'] });
    const issues = validateWorkflow(
      wf({ agents: { repair: { model: 'sonnet', escalateTo: 'fable' } } }), policy, known,
    );
    expect(issues.some((i) => i.path === 'agents.repair.escalateTo')).toBe(true);
  });
});

describe('W4 — the verifier cannot be given a model', () => {
  it('rejects a verifier binding by name', () => {
    const issues = validateWorkflow(
      { ...wf(), agents: { verifier: { model: 'opus', effort: 'high', thinking: 'adaptive' } } } as never,
      DEFAULT_POLICY, known,
    );
    const w4 = issues.find((i) => i.rule === 'W4');
    expect(w4?.severity).toBe('reject');
    expect(w4?.message).toContain('deterministic');
  });
});

describe('a workflow may only be stricter than policy (W5–W7)', () => {
  const policy = OrgPolicy.parse({
    requiredGates: ['compile', 'secretscan'],
    forbiddenPaths: ['**/*.pem', '.github/**'],
    maxAutonomy: 'gated',
    allowDependencyChanges: false,
    maxPerRunUsd: 10,
  });

  it('rejects dropping a required gate', () => {
    const issues = validateWorkflow(
      wf({ pipeline: { gates: { required: ['compile'] } } }), policy, known,
    );
    expect(issues.find((i) => i.rule === 'W5')?.message).toContain('secretscan');
  });

  it('rejects dropping a human gate the autonomy level demands', () => {
    const issues = validateWorkflow(wf({ hitl: { gates: ['G2', 'G3'] } }), policy, known);
    expect(issues.find((i) => i.rule === 'W6')?.message).toContain('G1');
  });

  it('rejects dropping a forbidden path', () => {
    const issues = validateWorkflow(
      wf({ guardrails: { forbiddenPaths: ['**/*.pem'] } }), policy, known,
    );
    expect(issues.find((i) => i.rule === 'W7')?.message).toContain('.github/**');
  });

  it('rejects re-enabling dependency changes', () => {
    const issues = validateWorkflow(
      wf({
        guardrails: { forbiddenPaths: policy.forbiddenPaths, allowDependencyChanges: true },
      }),
      policy, known,
    );
    expect(issues.some((i) => i.rule === 'W7' && i.path === 'guardrails.allowDependencyChanges')).toBe(true);
  });

  it('rejects a budget above the policy ceiling', () => {
    const issues = validateWorkflow(
      wf({ guardrails: { forbiddenPaths: policy.forbiddenPaths }, budgets: { perRunUsd: 50 } }),
      policy, known,
    );
    expect(issues.find((i) => i.path === 'budgets.perRunUsd')?.message).toContain('10');
  });

  it('accepts a workflow that is strictly tighter than policy', () => {
    const issues = validateWorkflow(
      wf({
        pipeline: { gates: { required: ['compile', 'secretscan', 'unit', 'coverage'] } },
        guardrails: { forbiddenPaths: [...policy.forbiddenPaths, '**/secrets/**'], maxFilesTouched: 10 },
        budgets: { perRunUsd: 5 },
      }),
      policy, known,
    );
    expect(issues).toEqual([]);
  });
});

describe('W8 — the remaining pipeline must be coherent', () => {
  it('rejects skipping a phase whose gate is still required', () => {
    const issues = validateWorkflow(
      wf({ pipeline: { skip: ['clarify'] }, hitl: { gates: ['G1', 'G2', 'G3'] } }),
      OrgPolicy.parse({ maxAutonomy: 'supervised' }), known,
    );
    expect(issues.find((i) => i.rule === 'W8')?.message).toContain('G1');
  });

  it('rejects verifying what was never implemented', () => {
    const issues = validateWorkflow(
      wf({ pipeline: { skip: ['implement'] }, hitl: { gates: ['G2', 'G3'] } }),
      OrgPolicy.parse({ maxAutonomy: 'supervised' }), known,
    );
    expect(issues.some((i) => i.message.includes('nothing to verify'))).toBe(true);
  });

  it('rejects shipping without verification', () => {
    const issues = validateWorkflow(
      wf({ pipeline: { skip: ['implement', 'verify'] }, hitl: { gates: ['G2', 'G3'] } }),
      OrgPolicy.parse({ maxAutonomy: 'supervised' }), known,
    );
    expect(issues.some((i) => i.message.includes('nothing would machine-check'))).toBe(true);
  });

  it('accepts the spike profile, which skips implement, verify and ship together', () => {
    const spike = BUILT_IN_WORKFLOWS.find((w) => w.name === 'spike')!;
    expect(validateWorkflow(spike, DEFAULT_POLICY, known)).toEqual([]);
  });
});

describe('loading and inheritance', () => {
  it('lets a user file override a built-in of the same name', () => {
    write('bug', { extends: 'feature', budgets: { perRunUsd: 3 } });
    const { workflows } = loadWorkflows(dir);
    expect(workflows.get('bug')!.definition.budgets.perRunUsd).toBe(3);
  });

  it('merges agent bindings per role instead of wholesale', () => {
    write('custom', { extends: 'feature', agents: { reviewer: { model: 'fable', effort: 'max' } } });
    const { workflows } = loadWorkflows(dir);
    const agents = workflows.get('custom')!.resolved.agents;
    expect(agents.reviewer?.model).toBe('fable');
    // Overriding the reviewer must not drop the inherited implementer binding.
    expect(agents.implementer?.model).toBe('sonnet');
    expect(agents.triage?.model).toBe('haiku');
  });

  it('accumulates forbidden paths down the inheritance chain', () => {
    write('custom', { extends: 'feature', guardrails: { forbiddenPaths: ['**/vendor/**'] } });
    const { workflows } = loadWorkflows(dir);
    const paths = workflows.get('custom')!.resolved.guardrails.forbiddenPaths;
    expect(paths).toContain('**/vendor/**');
    expect(paths).toContain('**/*.pem');
  });

  it('records the inheritance chain root first', () => {
    write('mid', { extends: 'feature' });
    write('leaf', { extends: 'mid' });
    const { workflows } = loadWorkflows(dir);
    expect(workflows.get('leaf')!.resolved.resolvedFrom).toEqual(['feature', 'mid', 'leaf']);
  });

  it('detects an inheritance cycle instead of hanging', () => {
    write('a', { extends: 'b' });
    write('b', { extends: 'a' });
    const { workflows } = loadWorkflows(dir);
    expect(workflows.get('a')!.issues.some((i) => i.rule === 'W2')).toBe(true);
    expect(workflows.get('a')!.runnable).toBe(false);
  });

  it('reports an unparseable file without failing the whole load', () => {
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    writeFileSync(join(dir, 'workflows', 'broken.yaml'), 'name: [not a slug\n  bad: yaml:', 'utf8');
    const { workflows, unreadable } = loadWorkflows(dir);
    expect(unreadable).toHaveLength(1);
    expect(workflows.get('feature')?.runnable).toBe(true);
  });

  it('rejects a name that is not a slug', () => {
    write('ok', {});
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    writeFileSync(join(dir, 'workflows', 'bad.yaml'), toYaml({ name: 'Not A Slug' }), 'utf8');
    const { unreadable } = loadWorkflows(dir);
    expect(unreadable[0]?.error).toContain('W1');
  });

  it('falls back to the strict default when policy.json is malformed', () => {
    writeFileSync(join(dir, 'policy.json'), '{"maxAutonomy": "none-at-all"}', 'utf8');
    // A typo in the policy file must not silently become "no policy".
    expect(loadWorkflows(dir).policy.maxAutonomy).toBe('gated');
  });

  it('marks a workflow unrunnable when policy forbids its model', () => {
    writePolicy({ forbiddenModels: ['fable'] });
    write('costly', { extends: 'feature', agents: { reviewer: { model: 'fable' } } });
    const { workflows } = loadWorkflows(dir);
    expect(workflows.get('costly')!.runnable).toBe(false);
  });
});
