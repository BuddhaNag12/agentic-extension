import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { PipelineProfile, ResolvedWorkflow } from '@agentflow/protocol';
import type { AgentProvider, AgentTurn, SessionOptions } from '../providers/types.js';
import type { GuardrailContext } from '../guardrails/types.js';
import { composePrompt } from '../prompts/compose.js';
import type { Spec } from './spec.js';
import type { ContextDigest } from './harvest.js';

/**
 * Stage 4 — Plan (§5). Read-only. Compiles a spec into a task DAG, then the
 * machine gate runs *before* a human ever sees it: do not waste human attention
 * on a malformed plan.
 */

export const TaskCheck = z.object({
  /** The gate that decides this criterion, or `manual` when nothing can. */
  gate: z.string().min(1),
  /** How the gate proves it — a test name, a grep, a command scope. */
  how: z.string().min(5),
});

export const PlanTask = z.object({
  id: z.string().regex(/^T\d+$/),
  title: z.string().min(5),
  intent: z.string().min(15),
  files: z.array(z.string()).min(1),
  dependsOn: z.array(z.string()),
  /** Spec acceptance-criterion ids this task serves. */
  satisfies: z.array(z.string().regex(/^AC\d+$/)).min(1),
  /** Machine checks. At least one non-manual is required by rule P3. */
  checks: z.array(TaskCheck).min(1),
  risk: z.enum(['low', 'medium', 'high']),
  estimatedEdits: z.number().int().min(1),
  /** Marks the failing-test-first task for bug-class tickets (rule P6). */
  isReproTest: z.boolean().default(false),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const Plan = z.object({
  strategy: z.string().min(20).max(1600),
  tasks: z.array(PlanTask).min(1),
  sequencing: z.string().min(10),
  testStrategy: z.object({
    newTests: z.array(z.object({
      task: z.string(),
      file: z.string(),
      cases: z.array(z.string()).min(1),
    })),
    regressionRisk: z.array(z.string()),
  }),
  migrations: z.array(z.string()),
  featureFlag: z.object({ required: z.boolean(), key: z.string().optional() }),
  rollbackPlan: z.string().min(20),
  outOfPlanPolicy: z.enum(['ask', 'allow_minor', 'block']),
  /** Set when the plan judges the ticket too large; rule P7 requires it. */
  proposedSplit: z.array(z.string()).optional(),
});
export type Plan = z.infer<typeof Plan>;

export interface PlanViolation {
  rule: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7';
  message: string;
  path?: string;
}

export interface PlanContext {
  spec: Spec;
  worktree: string;
  profile: PipelineProfile;
  maxEstimatedEdits: number;
  digest?: ContextDigest;
}

/**
 * PLAN_VALID (§5 Stage 4). Runs before a human sees the plan. Each violation
 * names the rule and the offending element, which is what the planner is
 * handed on a retry — "try again" is not actionable, "T3 has no machine check"
 * is.
 */
export function validatePlan(plan: Plan, ctx: PlanContext): PlanViolation[] {
  const issues: PlanViolation[] = [];
  const ids = new Set(plan.tasks.map((t) => t.id));

  // P2 — the graph must be a DAG with no dangling or orphaned references.
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        issues.push({ rule: 'P2', path: task.id, message: `${task.id} depends on ${dep}, which is not a task in this plan` });
      }
      if (dep === task.id) {
        issues.push({ rule: 'P2', path: task.id, message: `${task.id} depends on itself` });
      }
    }
  }
  const cycle = findCycle(plan.tasks);
  if (cycle) {
    issues.push({ rule: 'P2', path: cycle.join(' → '), message: `dependency cycle: ${cycle.join(' → ')}` });
  }
  if (plan.tasks.length > 1) {
    const duplicates = plan.tasks.filter((t, i) => plan.tasks.findIndex((o) => o.id === t.id) !== i);
    for (const dup of duplicates) {
      issues.push({ rule: 'P2', path: dup.id, message: `duplicate task id ${dup.id}` });
    }
  }

  // P3 — every task needs at least one machine-checkable criterion. This is what
  // stops the classic failure where the agent writes plausible code and declares
  // victory; without it the task has no way to be wrong.
  for (const task of plan.tasks) {
    if (!task.checks.some((c) => c.gate !== 'manual')) {
      issues.push({
        rule: 'P3', path: task.id,
        message: `${task.id} has no machine-checkable acceptance check; every task needs at least one non-manual gate`,
      });
    }
  }

  // P4 — coverage, both directions.
  const specIds = new Set(ctx.spec.acceptanceCriteria.map((ac) => ac.id));
  const covered = new Set(plan.tasks.flatMap((t) => t.satisfies));
  for (const ac of specIds) {
    if (!covered.has(ac)) {
      issues.push({ rule: 'P4', path: ac, message: `spec criterion ${ac} is not served by any task` });
    }
  }
  for (const task of plan.tasks) {
    for (const ac of task.satisfies) {
      if (!specIds.has(ac)) {
        issues.push({ rule: 'P4', path: task.id, message: `${task.id} claims to satisfy ${ac}, which is not in the spec` });
      }
    }
  }

  // P5 — a predicted path must exist, or be a plausible new file in a directory
  // that does. A plan that predicts paths under a module nobody has is a plan
  // written from imagination.
  for (const task of plan.tasks) {
    for (const file of task.files) {
      if (!pathIsPlausible(ctx.worktree, file)) {
        issues.push({
          rule: 'P5', path: task.id,
          message: `${task.id} predicts "${file}", which does not exist and is not under any existing directory`,
        });
      }
    }
  }

  // P6 — a bug fix starts with a test that fails against the current code.
  if (ctx.profile === 'bug') {
    const repro = plan.tasks.filter((t) => t.isReproTest);
    if (repro.length === 0) {
      issues.push({ rule: 'P6', message: 'a bug-class ticket needs a reproduction-test task; none is marked isReproTest' });
    } else {
      const order = topoOrder(plan.tasks);
      const first = order[0];
      if (first && !repro.some((t) => t.id === first)) {
        issues.push({
          rule: 'P6', path: first,
          message: `the reproduction test must run first, but ${first} is scheduled ahead of it`,
        });
      }
      for (const t of repro) {
        if (t.dependsOn.length > 0) {
          issues.push({ rule: 'P6', path: t.id, message: `${t.id} is the reproduction test and must not depend on other tasks` });
        }
      }
    }
  }

  // P7 — over budget, the plan must propose a split rather than attempt it.
  const totalEdits = plan.tasks.reduce((sum, t) => sum + t.estimatedEdits, 0);
  if (totalEdits > ctx.maxEstimatedEdits && !plan.proposedSplit?.length) {
    issues.push({
      rule: 'P7', path: 'tasks',
      message: `estimated ${totalEdits} edits exceeds the budget of ${ctx.maxEstimatedEdits}; the plan must propose a split instead`,
    });
  }

  return issues;
}

/** Exists, or is a new file under a directory that exists. */
export function pathIsPlausible(worktree: string, file: string): boolean {
  const root = resolve(worktree);
  const target = resolve(root, file);
  if (!target.startsWith(root)) return false;
  if (existsSync(target)) return true;
  // Walk up: a new file is plausible if any ancestor directory is real, but a
  // path under a module that does not exist is not.
  let dir = dirname(target);
  while (dir.startsWith(root) && dir !== root) {
    if (existsSync(dir)) return true;
    dir = dirname(dir);
  }
  return existsSync(join(root, dirname(file).split('/')[0] ?? ''));
}

function findCycle(tasks: readonly PlanTask[]): string[] | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };

  for (const task of tasks) {
    const found = visit(task.id);
    if (found) return found;
  }
  return undefined;
}

/** Dependencies first; ties broken by declared order so it is deterministic. */
export function topoOrder(tasks: readonly PlanTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: string[] = [];
  const seen = new Set<string>();

  const visit = (id: string, guard: Set<string>): void => {
    if (seen.has(id) || guard.has(id)) return;
    guard.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, guard);
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  };

  for (const task of tasks) visit(task.id, new Set());
  return out;
}

export interface PlanInput {
  ticketKey: string;
  spec: Spec;
  digest: ContextDigest;
  worktree: string;
  workflow: ResolvedWorkflow;
  profile: PipelineProfile;
  repoProfile?: string;
  /** Rule violations from a previous attempt, fed back verbatim. */
  previousViolations?: PlanViolation[];
}

export interface PlanResult {
  ok: boolean;
  plan?: Plan;
  violations: PlanViolation[];
  error?: string;
  turns: AgentTurn[];
  usd: number;
}

const PHASE_BRIEF = `
Compile this specification into a task DAG. You are not writing code, and you
have no write access.

Rules the machine gate enforces before any human sees this plan:

- Every task needs at least one **machine-checkable** check — a gate that can
  decide it, with \`how\` saying concretely what proves it (a test name, a grep,
  a command). A task whose checks are all \`manual\` is rejected: it has no way
  to be wrong. If a criterion seems unverifiable, find the check that would
  catch a regression, or split the task until one exists.
- Every acceptance criterion in the spec must be served by at least one task,
  and every id a task claims to satisfy must exist in the spec.
- \`dependsOn\` must form an acyclic graph over ids in this plan.
- Every predicted file must exist, or be a new file under a directory that
  exists. Do not predict paths under modules that are not there.
- If the work exceeds the edit budget you were given, do not attempt it: set
  \`proposedSplit\` describing how to divide the ticket.

Return JSON matching the schema you were given. Nothing else.
`.trim();

export async function runPlan(
  provider: AgentProvider,
  input: PlanInput,
  onTurn?: (turn: AgentTurn) => void,
): Promise<PlanResult> {
  const guardrails: GuardrailContext = {
    worktree: input.worktree,
    allowedPaths: ['<<none>>'],
    forbiddenPaths: input.workflow.guardrails.forbiddenPaths,
    maxFilesTouched: 0,
    filesTouched: new Set(),
    allowDependencyChanges: false,
    failingTestFiles: [],
  };

  const binding = input.workflow.agents.planner
    ?? { model: 'opus' as const, effort: 'xhigh' as const, thinking: 'adaptive' as const };
  const maxEstimatedEdits = input.workflow.guardrails.maxFilesTouched;

  const prompt = composePrompt({
    role: 'planner',
    workflow: input.workflow,
    ...(input.repoProfile ? { repoProfile: input.repoProfile } : {}),
    phaseBrief: PHASE_BRIEF,
    gates: input.workflow.pipeline.gates.required,
    allowedPaths: [],
    forbiddenPaths: input.workflow.guardrails.forbiddenPaths,
    maxFilesTouched: maxEstimatedEdits,
    questionsRemaining: 0,
  });

  const opts: SessionOptions = {
    role: 'planner',
    model: binding.model,
    effort: binding.effort,
    thinking: binding.thinking,
    systemPrompt: prompt.system,
    cwd: input.worktree,
    maxTurns: binding.maxTurns ?? 25,
    maxBudgetUsd: input.workflow.budgets.perRunUsd / 3,
    outputSchema: z.toJSONSchema(Plan),
    guardrails,
  };

  const session = await provider.createSession(opts);
  const turns: AgentTurn[] = [];
  let usd = 0;
  let raw: unknown;
  let error: string | undefined;

  try {
    const task = [
      `Ticket ${input.ticketKey}. Profile: ${input.profile}.`,
      `Edit budget: ${maxEstimatedEdits} files.`,
      `Gates available: ${input.workflow.pipeline.gates.required.join(', ') || 'none configured'}.`,
      '',
      '# Specification',
      '```json', JSON.stringify(input.spec, null, 2), '```',
      '',
      '# Harvest context',
      '```json', JSON.stringify(input.digest, null, 2), '```',
      ...(input.previousViolations?.length
        ? ['', '# Your previous plan was rejected by the gate', '',
           ...input.previousViolations.map((v) => `- [${v.rule}] ${v.path ?? ''} ${v.message}`),
           '', 'Fix exactly these and return the corrected plan.']
        : []),
      '',
      PHASE_BRIEF,
    ].join('\n');

    for await (const turn of session.send(task)) {
      turns.push(turn);
      onTurn?.(turn);
      if (turn.type === 'usage') usd += turn.usage?.usd ?? 0;
      if (turn.type === 'done') raw = turn.result;
      if (turn.type === 'error') error = turn.error;
    }
  } finally {
    await session.close();
  }

  if (error) return { ok: false, violations: [], error, turns, usd };

  const parsed = Plan.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false, violations: [], turns, usd,
      error: `plan did not match the schema: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  const violations = validatePlan(parsed.data, {
    spec: input.spec,
    worktree: input.worktree,
    profile: input.profile,
    maxEstimatedEdits,
    digest: input.digest,
  });
  return { ok: violations.length === 0, plan: parsed.data, violations, turns, usd };
}
