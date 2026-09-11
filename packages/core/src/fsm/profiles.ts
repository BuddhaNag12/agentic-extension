import { PHASE_OF_STEP, type Phase, type Step, type WorkflowDefinition } from '@agentflow/protocol';

/**
 * The linear spine of the pipeline (§5.1). Branching — repair, re-spec,
 * rejection — is expressed as transitions in the machine; this only orders the
 * happy path, at both levels: seven phases, and the steps inside each one.
 */
export const PHASE_ORDER: readonly Phase[] = [
  'intake', 'preflight', 'context', 'plan', 'build', 'review', 'ship',
] as const;

/**
 * The steps a phase walks in order. `repair` and `human_review` are absent on
 * purpose: they are entered by trigger (a failed gate, a parked gate), never
 * by falling off the end of the previous step.
 */
export const STEP_ORDER: Record<Phase, readonly Step[]> = {
  intake: ['classify', 'map_repo'],
  preflight: ['check_auth', 'worktree', 'detect_gates', 'check_budget', 'baseline_gates'],
  context: ['harvest', 'draft_spec', 'questions'],
  plan: ['draft_plan', 'validate_plan', 'decompose'],
  build: ['implement', 'verify'],
  review: ['auto_review', 'triage_findings'],
  ship: ['rebase', 'push', 'publish', 'notify'],
};

/**
 * Steps that resume the sequence somewhere other than after themselves.
 * Repair exists to make verify pass, so it hands control back to verify —
 * without this, a repaired tree would fall through to review unverified.
 */
export const STEP_AFTER: Partial<Record<Step, Step>> = {
  repair: 'verify',
};

/**
 * Steps that only run when the human has opted into pushing (§5.8). Ship
 * prepares the branch and stops by default: the push is the first
 * irreversible, externally-visible action in the whole pipeline.
 */
export const AUTO_PUSH_STEPS: readonly Step[] = ['push', 'publish', 'notify'] as const;

/**
 * What the machine needs to know about a run's shape. Derived from the run's
 * workflow (§21) — the workflow definition is the single source of truth for
 * which phases exist, and this is the projection of it the FSM consumes.
 */
export interface PipelineOptions {
  skip: readonly Phase[];
  skipSteps: readonly Step[];
  waitForCi: boolean;
  /** Set when a blocking question forces `questions` back into a pipeline
   *  whose workflow had skipped it. */
  forceQuestions?: boolean;
  /** §5.8: off by default, so ship's outbound steps do not run. */
  autoPush?: boolean;
}

export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  skip: [], skipSteps: [], waitForCi: false,
};

export function pipelineOptionsFor(workflow: WorkflowDefinition): PipelineOptions {
  return {
    skip: workflow.pipeline.skip,
    skipSteps: workflow.pipeline.skipSteps,
    waitForCi: workflow.pipeline.waitForCi,
  };
}

function isSkipped(phase: Phase, opts: PipelineOptions): boolean {
  return opts.skip.includes(phase);
}

function isStepSkipped(step: Step, opts: PipelineOptions): boolean {
  if (step === 'questions' && opts.forceQuestions) return false;
  if (AUTO_PUSH_STEPS.includes(step) && !opts.autoPush) return true;
  return opts.skipSteps.includes(step) || isSkipped(PHASE_OF_STEP[step], opts);
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

/** The first step of a phase, or undefined if every one of them is skipped. */
export function firstStep(phase: Phase, opts: PipelineOptions): Step | undefined {
  return STEP_ORDER[phase].find((s) => !isStepSkipped(s, opts));
}

/**
 * The next step within the current phase. Returns undefined once the phase's
 * steps are exhausted — including for a step the phase's order does not
 * contain, which is how `human_review` terminates the review phase.
 */
export function nextStep(phase: Phase, current: Step | undefined, opts: PipelineOptions): Step | undefined {
  if (current === undefined) return firstStep(phase, opts);

  const resume = STEP_AFTER[current];
  if (resume !== undefined) {
    return isStepSkipped(resume, opts) ? nextStep(phase, resume, opts) : resume;
  }

  const order = STEP_ORDER[phase];
  let i = order.indexOf(current);
  if (i < 0) return undefined;
  for (i += 1; i < order.length; i += 1) {
    const candidate = order[i]!;
    if (!isStepSkipped(candidate, opts)) return candidate;
  }
  return undefined;
}

/** The phases a run will actually visit — used by the UI to draw progress. */
export function plannedPhases(opts: PipelineOptions): Phase[] {
  return PHASE_ORDER.filter((p) => !isSkipped(p, opts));
}

/** The steps a run will actually visit, in order, across every phase. */
export function plannedSteps(opts: PipelineOptions): Step[] {
  return plannedPhases(opts).flatMap((p) => STEP_ORDER[p].filter((s) => !isStepSkipped(s, opts)));
}
