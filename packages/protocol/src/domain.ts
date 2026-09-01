import { z } from 'zod';

/**
 * Domain schemas. One zod definition per concept, exported three ways:
 * runtime validation (orchestrator), TS types (everywhere), JSON Schema
 * (the model's `outputFormat`). See architecture doc §17.2.
 */

export const SCHEMA_VERSION = '1.0.0';

// --- identifiers -----------------------------------------------------------

export const RunId = z.string().uuid();
export const TicketKey = z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/, 'expected a ticket key like PAY-1423');
/** Repo-qualified so v2 multi-repo is an additive change, not a schema break (§20.6). */
export const RepoId = z.string().min(1);

// --- phases ----------------------------------------------------------------

/**
 * `wait_for_ci` is present per the §20.3 recommendation (local gates in the
 * loop, CI as pre-ship truth). It is skipped unless config enables it.
 */
export const Phase = z.enum([
  'intake', 'harvest', 'spec', 'clarify', 'plan',
  'decompose', 'implement', 'verify', 'repair',
  'review', 'wait_for_ci', 'human_review', 'ship', 'done',
]);
export type Phase = z.infer<typeof Phase>;

export const RunStatus = z.enum([
  'queued', 'running', 'waiting_human', 'blocked',
  'failed', 'cancelled', 'succeeded',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const PipelineProfile = z.enum(['feature', 'bug', 'chore', 'refactor', 'spike']);
export type PipelineProfile = z.infer<typeof PipelineProfile>;

export const GateId = z.string().min(1);
export type GateId = z.infer<typeof GateId>;

export const HumanGate = z.enum(['G1', 'G2', 'G3']);
export type HumanGate = z.infer<typeof HumanGate>;

// --- artifacts -------------------------------------------------------------

export const ArtifactKind = z.enum([
  'context', 'spec', 'plan', 'taskgraph', 'review', 'testreport', 'diff',
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** Artifacts are versioned, never overwritten (§3.1). */
export const ArtifactRef = z.object({
  kind: ArtifactKind,
  version: z.number().int().positive(),
  path: z.string(),
  schemaVersion: z.string(),
  approvedBy: z.string().optional(),
  approvedAt: z.number().optional(),
  editedByHuman: z.boolean().default(false),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

// --- tickets and repos -----------------------------------------------------

export const TicketRef = z.object({
  key: TicketKey,
  summary: z.string(),
  url: z.string().url().optional(),
  profile: PipelineProfile,
  tracker: z.enum(['jira', 'linear', 'github', 'manual']).default('jira'),
});
export type TicketRef = z.infer<typeof TicketRef>;

export const RepoRef = z.object({
  id: RepoId,
  path: z.string(),
  /** Where the run branches from. §20.5: usually `origin/<base>`, but a user
   *  may explicitly base a run on their current branch. */
  baseRef: z.string().default('origin/main'),
  baseSha: z.string().optional(),
});
export type RepoRef = z.infer<typeof RepoRef>;

// --- budgets and cost ------------------------------------------------------

export const AttemptBudget = z.object({
  perTask: z.number().int().positive().default(4),
  perRun: z.number().int().positive().default(12),
  maxUsd: z.number().positive().default(8),
  maxWallClockMin: z.number().int().positive().default(90),
});
export type AttemptBudget = z.infer<typeof AttemptBudget>;

export const CostLedger = z.object({
  usd: z.number().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
});
export type CostLedger = z.infer<typeof CostLedger>;

// --- task graph (§3.2) -----------------------------------------------------

export const GateSpec = z.object({
  gate: GateId,
  scope: z.string().optional(),
});
export type GateSpec = z.infer<typeof GateSpec>;

export const AcceptanceCriterion = z.object({
  id: z.string(),
  statement: z.string(),
  /** Must be machine-checkable unless explicitly `manual`. Plan validation
   *  rejects any task whose criteria are all `manual` (§3.2). */
  check: z.union([GateSpec, z.literal('manual')]),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const TaskStatus = z.enum([
  'pending', 'active', 'verifying', 'repairing', 'done', 'abandoned',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  id: z.string(),
  repo: RepoId.optional(),
  title: z.string(),
  intent: z.string(),
  files: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  acceptance: z.array(AcceptanceCriterion).default([]),
  verification: z.array(GateSpec).default([]),
  risk: z.enum(['low', 'medium', 'high']).default('medium'),
  estimatedEdits: z.number().int().nonnegative().default(0),
  status: TaskStatus.default('pending'),
});
export type Task = z.infer<typeof Task>;

// --- gates -----------------------------------------------------------------

export const Failure = z.object({
  file: z.string().optional(),
  line: z.number().int().optional(),
  rule: z.string().optional(),
  message: z.string(),
});
export type Failure = z.infer<typeof Failure>;

export const GateReport = z.object({
  gate: GateId,
  ok: z.boolean(),
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  failures: z.array(Failure).default([]),
  /** Path to the full log on disk — never inlined into the event log (§5 Stage 7). */
  raw: z.string().optional(),
  /** Hash of the normalized failure set; drives thrash detection (§9.1). */
  signature: z.string(),
});
export type GateReport = z.infer<typeof GateReport>;

// --- questions and approvals (§7) -----------------------------------------

export const QuestionOption = z.object({ label: z.string(), implication: z.string() });

export const Question = z.object({
  id: z.string(),
  question: z.string().max(280),
  whyItMatters: z.string().max(200),
  alreadyChecked: z.array(z.string()).min(1),
  options: z.array(QuestionOption).max(4).optional(),
  allowFreeText: z.boolean().default(true),
  blocking: z.boolean(),
  defaultIfUnanswered: z.string().optional(),
  confidenceWithoutAnswer: z.number().min(0).max(1),
  phase: Phase,
});
export type Question = z.infer<typeof Question>;

export const Answer = z.object({
  questionId: z.string(),
  choice: z.string().optional(),
  freeText: z.string().optional(),
  deferred: z.boolean().default(false),
  answeredBy: z.string(),
  answeredAt: z.number(),
});
export type Answer = z.infer<typeof Answer>;

export const ApprovalDecision = z.enum(['approve', 'reject', 'revise']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const ApprovalRequest = z.object({
  id: z.string(),
  runId: RunId,
  gate: HumanGate,
  artifact: ArtifactRef,
  diffAgainst: ArtifactRef.optional(),
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  cost: z.object({ soFarUsd: z.number(), projectedUsd: z.number() }),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

// --- the run ---------------------------------------------------------------

export const Run = z.object({
  id: RunId,
  ticket: TicketRef,
  repo: RepoRef,
  worktree: z.string(),
  branch: z.string(),
  /** Name of the workflow (§21) that selects this run's phases, gates and agents. */
  workflow: z.string().default('feature'),
  phase: Phase,
  status: RunStatus,
  attemptBudget: AttemptBudget,
  cost: CostLedger,
  createdAt: z.number(),
  updatedAt: z.number(),
  artifacts: z.record(ArtifactKind, ArtifactRef).default({}),
  sessions: z.record(Phase, z.string()).default({}),
  tasks: z.array(Task).default([]),
});
export type Run = z.infer<typeof Run>;
