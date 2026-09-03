import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  DEFAULT_POLICY, OrgPolicy, WorkflowDefinition,
  type AgentRole, type ResolvedWorkflow, type WorkflowIssue,
} from '@agentflow/protocol';
import { BUILT_IN_WORKFLOWS } from './builtins.js';
import { rejections, validateWorkflow } from './validate.js';

/**
 * Loads workflow definitions from `.agentflow/workflows/*.yaml` (§21.1).
 * Built-ins are seeded to disk on first run so they are readable and forkable,
 * and then loaded by the same path as anything a user wrote.
 */

export interface LoadedWorkflow {
  definition: WorkflowDefinition;
  resolved: ResolvedWorkflow;
  issues: WorkflowIssue[];
  runnable: boolean;
  path?: string;
}

export interface LoadResult {
  workflows: Map<string, LoadedWorkflow>;
  policy: OrgPolicy;
  /** Files that could not be parsed at all, kept so the UI can show them. */
  unreadable: { path: string; error: string }[];
}

export function loadPolicy(agentflowDir: string): OrgPolicy {
  const path = join(agentflowDir, 'policy.json');
  if (!existsSync(path)) return DEFAULT_POLICY;
  const parsed = OrgPolicy.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  // A malformed policy file must not silently become "no policy" — that would
  // turn a typo into an autonomy escalation. Fall back to the strict default.
  return parsed.success ? parsed.data : DEFAULT_POLICY;
}

/** Write the built-ins to disk if they are not already there. */
export function seedBuiltIns(workflowsDir: string): string[] {
  mkdirSync(workflowsDir, { recursive: true });
  const written: string[] = [];
  for (const wf of BUILT_IN_WORKFLOWS) {
    const path = join(workflowsDir, `${wf.name}.yaml`);
    if (existsSync(path)) continue;
    writeFileSync(path, stringifyYaml(wf), 'utf8');
    written.push(path);
  }
  return written;
}

export function loadWorkflows(agentflowDir: string, seed = true): LoadResult {
  const workflowsDir = join(agentflowDir, 'workflows');
  const policy = loadPolicy(agentflowDir);
  if (seed) seedBuiltIns(workflowsDir);

  const raw = new Map<string, { def: WorkflowDefinition; path?: string }>();
  const unreadable: { path: string; error: string }[] = [];

  // Built-ins are registered first so a user file of the same name overrides
  // rather than duplicates — forking a built-in should just work.
  for (const wf of BUILT_IN_WORKFLOWS) raw.set(wf.name, { def: wf });

  if (existsSync(workflowsDir)) {
    for (const file of readdirSync(workflowsDir)) {
      if (!/\.ya?ml$/.test(file)) continue;
      const path = join(workflowsDir, file);
      try {
        const parsed = WorkflowDefinition.safeParse(parseYaml(readFileSync(path, 'utf8')));
        if (!parsed.success) {
          unreadable.push({ path, error: `W1: ${formatZodError(parsed.error)}` });
          continue;
        }
        raw.set(parsed.data.name, { def: parsed.data, path });
      } catch (err) {
        unreadable.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const known = new Set(raw.keys());
  const workflows = new Map<string, LoadedWorkflow>();

  for (const [name, { def, path }] of raw) {
    const issues = [...validateWorkflow(def, policy, known)];
    const resolution = resolve(def, raw);
    if ('cycle' in resolution) {
      issues.push({
        rule: 'W2', severity: 'reject', path: 'extends',
        message: `inheritance cycle: ${resolution.cycle.join(' → ')}`,
      });
    }
    const resolved = 'cycle' in resolution ? asResolved(def, [def.name]) : resolution.workflow;
    workflows.set(name, {
      definition: def,
      resolved,
      issues,
      runnable: rejections(issues).length === 0 && issues.every((i) => i.severity !== 'block'),
      ...(path ? { path } : {}),
    });
  }

  return { workflows, policy, unreadable };
}

/**
 * Apply `extends` from the root down, so a child's fields win. Agent bindings
 * merge per role rather than wholesale — overriding the reviewer should not
 * silently drop the implementer binding you inherited.
 */
function resolve(
  def: WorkflowDefinition,
  all: ReadonlyMap<string, { def: WorkflowDefinition }>,
): { workflow: ResolvedWorkflow } | { cycle: string[] } {
  const chain: WorkflowDefinition[] = [];
  const seen = new Set<string>();
  let current: WorkflowDefinition | undefined = def;

  while (current) {
    if (seen.has(current.name)) return { cycle: [...seen, current.name] };
    seen.add(current.name);
    chain.unshift(current);
    const parentName: string | undefined = current.extends;
    current = parentName ? all.get(parentName)?.def : undefined;
  }

  let merged = chain[0]!;
  for (const next of chain.slice(1)) merged = mergeOne(merged, next);
  return { workflow: asResolved(merged, chain.map((c) => c.name)) };
}

function mergeOne(parent: WorkflowDefinition, child: WorkflowDefinition): WorkflowDefinition {
  return {
    ...parent,
    ...child,
    pipeline: {
      ...parent.pipeline,
      ...child.pipeline,
      gates: { ...parent.pipeline.gates, ...child.pipeline.gates },
    },
    agents: mergeAgents(parent.agents, child.agents),
    budgets: { ...parent.budgets, ...child.budgets },
    guardrails: {
      ...parent.guardrails,
      ...child.guardrails,
      // Forbidden paths accumulate: a child cannot drop what a parent forbade.
      forbiddenPaths: [...new Set([...parent.guardrails.forbiddenPaths, ...child.guardrails.forbiddenPaths])],
    },
    hitl: { ...parent.hitl, ...child.hitl },
  };
}

function mergeAgents(
  parent: WorkflowDefinition['agents'],
  child: WorkflowDefinition['agents'],
): WorkflowDefinition['agents'] {
  const out = { ...parent };
  for (const [role, binding] of Object.entries(child) as [AgentRole, unknown][]) {
    if (!binding) continue;
    out[role] = { ...out[role], ...(binding as object) } as never;
  }
  return out;
}

function asResolved(def: WorkflowDefinition, from: string[]): ResolvedWorkflow {
  return { ...def, resolvedFrom: from } as ResolvedWorkflow;
}

function formatZodError(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}
