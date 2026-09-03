import { z } from 'zod';
import { GateId, HumanGate, Phase } from './domain.js';
import { AgentRole, Effort, ModelAlias, ThinkingMode } from './models.js';

/**
 * Workflow definitions (§21). A workflow is a named, committed selection of
 * phases, gates, per-role agent bindings, budgets and guardrails. The five
 * built-in profiles ship as definitions loaded by this same schema — there are
 * no privileged built-ins.
 */

export const WORKFLOW_SCHEMA_VERSION = '1.0.0';

/** Lowercase slug: it names a file and appears in the RPC contract. */
export const WorkflowName = z.string().regex(
  /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
  'workflow names are lowercase slugs, e.g. "payments-hotfix"',
).max(64);

export const AgentBinding = z.object({
  model: ModelAlias,
  effort: Effort.default('high'),
  thinking: ThinkingMode.default('adaptive'),
  /** Rung 3 of the §9.2 escalation ladder switches to this model. */
  escalateTo: ModelAlias.optional(),
  /** For `harvest` and `reviewer`: which passes actually run. */
  subagents: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
});
export type AgentBinding = z.infer<typeof AgentBinding>;

export const WorkflowPipeline = z.object({
  skip: z.array(Phase).default([]),
  waitForCi: z.boolean().default(false),
  gates: z.object({
    required: z.array(GateId).default([]),
    coverageThreshold: z.number().min(0).max(1).default(0.8),
  }).prefault({}),
});

export const WorkflowBudgets = z.object({
  perRunUsd: z.number().positive().default(8),
  perTicketMinutes: z.number().int().positive().default(90),
  attemptsPerTask: z.number().int().positive().default(4),
  attemptsPerRun: z.number().int().positive().default(12),
  /** Advisory pacing signal for an agentic task, not a hard cap (§21.6). */
  taskBudgetTokens: z.number().int().min(20_000).optional(),
});
export type WorkflowBudgets = z.infer<typeof WorkflowBudgets>;

export const WorkflowGuardrails = z.object({
  forbiddenPaths: z.array(z.string()).default([]),
  maxFilesTouched: z.number().int().positive().default(40),
  allowDependencyChanges: z.boolean().default(false),
});
export type WorkflowGuardrails = z.infer<typeof WorkflowGuardrails>;

export const WorkflowHitl = z.object({
  gates: z.array(HumanGate).default(['G1', 'G2', 'G3']),
  /** 0 means the phase asks nothing and records assumptions instead — this is
   *  how a profile "skips Q&A" without losing the gate that follows it. */
  maxQuestionsPerPhase: z.number().int().min(0).max(10).default(5),
});

export const WorkflowDefinition = z.object({
  name: WorkflowName,
  displayName: z.string().optional(),
  description: z.string().default(''),
  schemaVersion: z.string().default(WORKFLOW_SCHEMA_VERSION),
  /** Inherit from another workflow, then override. Cycles are rejected (W2). */
  extends: WorkflowName.optional(),
  builtIn: z.boolean().default(false),
  pipeline: WorkflowPipeline.prefault({}),
  /**
   * Passthrough is off: an unknown role must be a loud error. `verifier` in
   * particular has to be rejected by name rather than silently ignored (W4).
   */
  agents: z.partialRecord(AgentRole, AgentBinding).default({}),
  budgets: WorkflowBudgets.prefault({}),
  guardrails: WorkflowGuardrails.prefault({}),
  hitl: WorkflowHitl.prefault({}),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

/** A workflow with `extends` fully applied and every default filled in. */
export interface ResolvedWorkflow extends WorkflowDefinition {
  /** The inheritance chain, root first — shown in the UI so an inherited
   *  value can be traced to the file that set it. */
  resolvedFrom: string[];
}

/**
 * The org policy a workflow may only be stricter than (§21.5, §14). Committed,
 * and not overridable by a user or by a workflow.
 */
export const OrgPolicy = z.object({
  forbiddenPaths: z.array(z.string()).default([]),
  requiredGates: z.array(GateId).default([]),
  /** 'gated' requires all three human gates; 'supervised' requires G2 and G3. */
  maxAutonomy: z.enum(['gated', 'supervised']).default('gated'),
  allowDependencyChanges: z.boolean().default(false),
  forbiddenModels: z.array(ModelAlias).default([]),
  maxPerRunUsd: z.number().positive().optional(),
  telemetry: z.enum(['on', 'off']).default('off'),
});
export type OrgPolicy = z.infer<typeof OrgPolicy>;

export const DEFAULT_POLICY: OrgPolicy = OrgPolicy.parse({});

/** Which human gates each autonomy level demands. */
export const AUTONOMY_GATES: Record<OrgPolicy['maxAutonomy'], HumanGate[]> = {
  gated: ['G1', 'G2', 'G3'],
  supervised: ['G2', 'G3'],
};

export const WorkflowIssue = z.object({
  rule: z.enum(['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8']),
  /** `reject` refuses the definition; `block` loads it but bars it from running. */
  severity: z.enum(['reject', 'block']),
  message: z.string(),
  path: z.string().optional(),
});
export type WorkflowIssue = z.infer<typeof WorkflowIssue>;
