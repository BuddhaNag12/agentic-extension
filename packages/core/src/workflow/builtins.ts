import type { WorkflowDefinition } from '@agentflow/protocol';

/**
 * The five profiles from §5.10, expressed as workflow definitions rather than
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
  schemaVersion: '1.0.0',
  builtIn: true,
  pipeline: { skip: [], waitForCi: false, gates: { required: STANDARD_GATES, coverageThreshold: 0.8 } },
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
    pipeline: {
      skip: [], waitForCi: false,
      gates: { required: [...STANDARD_GATES, 'repro_test'], coverageThreshold: 0.8 },
    },
  }),

  base({
    name: 'chore',
    displayName: 'Chore',
    // Clarify still runs — skipping it would drop G1 with it, and §7.1's three
    // gates are the invariant. What a chore skips is the *questions*: the phase
    // records its assumptions and presents the spec for a fast confirmation.
    description: 'Asks no clarifying questions; records assumptions and confirms the spec.',
    hitl: { gates: ['G1', 'G2', 'G3'], maxQuestionsPerPhase: 0 },
    budgets: { perRunUsd: 4, perTicketMinutes: 45, attemptsPerTask: 3, attemptsPerRun: 8 },
  }),

  base({
    name: 'refactor',
    displayName: 'Refactor',
    description: 'Behaviour-preserving: existing tests unchanged and green, no new public API.',
    pipeline: {
      skip: [], waitForCi: false,
      gates: { required: [...STANDARD_GATES, 'behaviour_preservation'], coverageThreshold: 0.8 },
    },
    hitl: { gates: ['G1', 'G2', 'G3'], maxQuestionsPerPhase: 0 },
  }),

  base({
    name: 'spike',
    displayName: 'Spike',
    // Produces a document and a throwaway branch. Keeps G3 — the gate's
    // question becomes "are these findings good?" rather than "would I merge
    // this?" — which holds the three-gate invariant uniform (DECISIONS D11).
    description: 'Investigation only. Produces a document, never ships code.',
    pipeline: {
      skip: ['implement', 'verify', 'review', 'ship'], waitForCi: false,
      gates: { required: [], coverageThreshold: 0 },
    },
    agents: { ...DEFAULT_AGENTS, analyst: { model: 'opus', effort: 'max', thinking: 'adaptive' } },
    budgets: { perRunUsd: 6, perTicketMinutes: 60, attemptsPerTask: 2, attemptsPerRun: 4 },
  }),
];

export const BUILT_IN_NAMES = new Set(BUILT_IN_WORKFLOWS.map((w) => w.name));
