import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from '@agentflow/protocol';

/**
 * The five profiles from §5.9, expressed as workflow definitions rather than
 * as branches in a switch. They are materialized to `.agentflow/workflows/` on
 * first run so they are readable and forkable, and they load through exactly
 * the same path as a user-authored workflow.
 */

const STANDARD_GATES = ['compile', 'lint', 'unit', 'coverage', 'secretscan'];

/** The §6.1 default bindings. Every workflow may override them per role. */
const DEFAULT_AGENTS: WorkflowDefinition['agents'] = {
  triage: { model: 'haiku', effort: 'low', thinking: 'off' },
  harvest: { model: 'sonnet', effort: 'low', thinking: 'adaptive' },
  analyst: { model: 'opus', effort: 'high', thinking: 'adaptive' },
  planner: { model: 'opus', effort: 'xhigh', thinking: 'adaptive' },
  implementer: { model: 'sonnet', effort: 'medium', thinking: 'adaptive' },
  repair: { model: 'sonnet', effort: 'medium', thinking: 'adaptive', escalateTo: 'opus' },
  reviewer: { model: 'opus', effort: 'xhigh', thinking: 'adaptive' },
  summarizer: { model: 'haiku', effort: 'low', thinking: 'off' },
};

const base = (over: Partial<WorkflowDefinition>): WorkflowDefinition => ({
  name: 'feature',
  description: '',
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  builtIn: true,
  kind: 'deliver',
  pipeline: {
    skip: [], skipSteps: [], waitForCi: false,
    gates: { required: STANDARD_GATES, coverageThreshold: 0.8 },
  },
  agents: DEFAULT_AGENTS,
  budgets: { perRunUsd: 8, perTicketMinutes: 90, attemptsPerTask: 4, attemptsPerRun: 12 },
  guardrails: {
    forbiddenPaths: ['**/*.pem', '**/local.properties', '.github/**', '**/*.keystore', '.env*'],
    maxFilesTouched: 40,
    allowDependencyChanges: false,
  },
  hitl: { gates: ['G1', 'G2', 'G3'], maxQuestionsPerPhase: 5 },
  ...over,
});

export const BUILT_IN_WORKFLOWS: WorkflowDefinition[] = [
  base({
    name: 'feature',
    displayName: 'Feature',
    description: 'The full pipeline. Every phase, every gate.',
  }),

  base({
    name: 'bug',
    displayName: 'Bug',
    description: 'Reproduction test first: a test that fails before the fix and passes after.',
    // No `repro_test` gate: PLAN_VALID's rule P6 already rejects a bug plan
    // whose first task is not a failing reproduction test, which is where the
    // requirement is actually enforceable. Declaring it here as well named a
    // gate no adapter implements, and an unimplemented required gate was
    // silently skipped — a `bug` run reported ALL_GATES_GREEN having never run
    // the one check the profile exists for (DECISIONS D44).
    pipeline: {
      skip: [], skipSteps: [], waitForCi: false,
      gates: { required: STANDARD_GATES, coverageThreshold: 0.8 },
    },
  }),

  base({
    name: 'chore',
    displayName: 'Chore',
    // The `questions` step still runs — skipping it would drop G1 with it, and
    // §9.1's three gates are the invariant. What a chore skips is the
    // *questions themselves*: the step records its assumptions and presents
    // the spec for a fast confirmation (DECISIONS D13).
    description: 'Asks no clarifying questions; records assumptions and confirms the spec.',
    hitl: { gates: ['G1', 'G2', 'G3'], maxQuestionsPerPhase: 0 },
    budgets: { perRunUsd: 4, perTicketMinutes: 45, attemptsPerTask: 3, attemptsPerRun: 8 },
  }),

  base({
    name: 'refactor',
    displayName: 'Refactor',
    description: 'Behaviour-preserving: existing tests unchanged and green, no new public API.',
    // `behaviour_preservation` has no adapter yet, so preflight refuses this
    // workflow by name rather than running it without the one gate that makes
    // it a refactor rather than a rewrite. Blocking is the honest state: it was
    // previously declared and silently skipped.
    pipeline: {
      skip: [], skipSteps: [], waitForCi: false,
      gates: { required: [...STANDARD_GATES, 'behaviour_preservation'], coverageThreshold: 0.8 },
    },
    hitl: { gates: ['G1', 'G2', 'G3'], maxQuestionsPerPhase: 0 },
  }),

  base({
    name: 'pr-review',
    displayName: 'PR review',
    kind: 'review',
    // §7.2: a PR review skips Plan and Build, and its Context step asks what
    // the PR *claims* rather than drafting a specification — there is nothing
    // to specify, the change already exists.
    //
    // Only G3, and that is not a relaxation: G1 approves a spec and G2 a plan,
    // and this pipeline produces neither, so demanding them would make the
    // profile unexpressible rather than safer (§7 and DECISIONS D68).
    description: 'Review an inbound pull request. Reads the diff, runs the gates, posts nothing.',
    pipeline: {
      skip: ['plan', 'build', 'ship'],
      skipSteps: ['draft_spec', 'questions'],
      waitForCi: false,
      gates: { required: STANDARD_GATES, coverageThreshold: 0.8 },
    },
    hitl: { gates: ['G3'], maxQuestionsPerPhase: 0 },
    budgets: { perRunUsd: 3, perTicketMinutes: 30, attemptsPerTask: 1, attemptsPerRun: 1 },
  }),

  base({
    name: 'spike',
    displayName: 'Spike',
    // Produces a document and a throwaway branch. Skips `build` and `ship`
    // per §5.9, and `auto_review` because there is no diff to read — but keeps
    // the `review` phase, where G3's question becomes "are these findings
    // good?" rather than "would I merge this?" (DECISIONS D11).
    description: 'Investigation only. Produces a document, never ships code.',
    pipeline: {
      skip: ['build', 'ship'], skipSteps: ['auto_review'], waitForCi: false,
      gates: { required: [], coverageThreshold: 0 },
    },
    agents: { ...DEFAULT_AGENTS, analyst: { model: 'opus', effort: 'max', thinking: 'adaptive' } },
    budgets: { perRunUsd: 6, perTicketMinutes: 60, attemptsPerTask: 2, attemptsPerRun: 4 },
  }),
];

export const BUILT_IN_NAMES = new Set(BUILT_IN_WORKFLOWS.map((w) => w.name));
