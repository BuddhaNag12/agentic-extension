import type { Phase, WorkflowDefinition } from '@agentflow/protocol';

/**
 * The linear spine of the pipeline (§5). Branching (repair, re-spec, rejection)
 * is expressed as transitions in the machine; this only orders the happy path.
 */
export const PHASE_ORDER: readonly Phase[] = [
  'intake', 'harvest', 'spec', 'clarify', 'plan', 'decompose',
  'implement', 'verify', 'review', 'wait_for_ci', 'human_review', 'ship', 'done',
] as const;

/**
 * What the machine needs to know about a run's shape. Derived from the run's
 * workflow (§21) — the workflow definition is the single source of truth for
 * which phases exist, and this is the projection of it the FSM consumes.
 */
export interface PipelineOptions {
  skip: readonly Phase[];
  waitForCi: boolean;
  /** Set when a blocking question forces clarify back into a pipeline that skips it. */
  forceClarify?: boolean;
}

export function pipelineOptionsFor(workflow: WorkflowDefinition): PipelineOptions {
  return { skip: workflow.pipeline.skip, waitForCi: workflow.pipeline.waitForCi };
}

function isSkipped(phase: Phase, opts: PipelineOptions): boolean {
  if (phase === 'wait_for_ci') return !opts.waitForCi;
  if (phase === 'clarify' && opts.forceClarify) return false;
  return opts.skip.includes(phase);
}

/** The next phase on the happy path, skipping whatever the workflow omits. */
export function nextPhase(current: Phase, opts: PipelineOptions): Phase | undefined {
  let i = PHASE_ORDER.indexOf(current);
  if (i < 0) return undefined;
  for (i += 1; i < PHASE_ORDER.length; i += 1) {
    const candidate = PHASE_ORDER[i]!;
    if (!isSkipped(candidate, opts)) return candidate;
  }
  return undefined;
}

/** The phases a run will actually visit — used by the UI to draw progress. */
export function plannedPhases(opts: PipelineOptions): Phase[] {
  return PHASE_ORDER.filter((p) => !isSkipped(p, opts));
}
