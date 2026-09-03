import { dirname } from 'node:path';
import type { ResolvedWorkflow } from '@agentflow/protocol';
import { ALWAYS_FORBIDDEN } from '../guardrails/paths.js';
import type { ContextDigest } from './harvest.js';
import type { Plan, PlanTask } from './plan.js';
import { topoOrder } from './plan.js';
import type { Spec } from './spec.js';

/**
 * Stage 5 — Decompose (§5). Mechanical: no model runs here. The approved plan
 * compiles into self-contained work packets, one per task.
 *
 * The guardrails on each packet are the concrete, enforceable version of "stay
 * in scope" — enforced by the hook in §7.4, not by prompt instruction.
 */

export interface WorkPacket {
  task: PlanTask;
  contextSlice: {
    /** Read-first list: the files this task is about. */
    files: string[];
    /** Only the acceptance criteria this task serves, not the whole spec. */
    specExcerpt: { id: string; statement: string; checkable: boolean }[];
    conventions: string[];
    /** What earlier tasks already changed, so this one does not redo it. */
    completed: { id: string; title: string }[];
  };
  gates: string[];
  guardrails: {
    allowedPaths: string[];
    forbiddenPaths: string[];
    maxFilesTouched: number;
    maxNewDeps: number;
  };
}

export interface DecomposeInput {
  plan: Plan;
  spec: Spec;
  digest: ContextDigest;
  workflow: ResolvedWorkflow;
}

/**
 * Compile the plan into packets in dependency order. Deterministic: the same
 * plan always produces the same packets, which is what lets the scenario tests
 * assert on them without a model.
 */
export function decompose(input: DecomposeInput): WorkPacket[] {
  const { plan, spec, digest, workflow } = input;
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const order = topoOrder(plan.tasks);
  const criteria = new Map(spec.acceptanceCriteria.map((ac) => [ac.id, ac]));
  const completed: { id: string; title: string }[] = [];
  const packets: WorkPacket[] = [];

  for (const id of order) {
    const task = byId.get(id);
    if (!task) continue;

    packets.push({
      task,
      contextSlice: {
        files: task.files,
        specExcerpt: task.satisfies.flatMap((acId) => {
          const ac = criteria.get(acId);
          return ac ? [{ id: ac.id, statement: ac.statement, checkable: ac.checkable }] : [];
        }),
        conventions: digest.conventions,
        completed: [...completed],
      },
      // Only the gates this task actually names, in the ladder's cost order.
      gates: dedupe(task.checks.map((c) => c.gate).filter((g) => g !== 'manual')),
      guardrails: {
        allowedPaths: allowedPathsFor(task),
        forbiddenPaths: dedupe([...workflow.guardrails.forbiddenPaths, ...ALWAYS_FORBIDDEN]),
        // A task's own estimate bounds it, but never above the workflow ceiling,
        // and always with headroom of one: a plan that predicts three files
        // often needs a fourth (an index, a barrel export) and should not have
        // to escalate for it.
        maxFilesTouched: Math.min(task.estimatedEdits + 1, workflow.guardrails.maxFilesTouched),
        maxNewDeps: workflow.guardrails.allowDependencyChanges ? 1 : 0,
      },
    });
    completed.push({ id: task.id, title: task.title });
  }

  return packets;
}

/**
 * A task may write the files it predicted, and siblings in those directories —
 * a component's test lives beside it and was rarely predicted by name. It may
 * not wander into another module: that is the scope explosion §9.3 blocks.
 */
function allowedPathsFor(task: PlanTask): string[] {
  const globs = new Set<string>();
  for (const file of task.files) {
    globs.add(file);
    const dir = dirname(file);
    if (dir && dir !== '.') globs.add(`${dir}/*`);
  }
  return [...globs];
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
