import { z } from 'zod';
import {
  ApprovalDecision, ApprovalRequest, HumanGate, PipelineProfile,
  Question, Run, RunId,
} from './domain.js';
import { EnvelopedEvent } from './events.js';

/**
 * The JSON-RPC 2.0 contract between the extension host and the orchestrator
 * daemon (§2.3). Requests flow one way; all UI updates are push notifications.
 */

export const PROTOCOL_VERSION = 1;

// --- requests (extension → orchestrator) -----------------------------------

export const HandshakeParams = z.object({
  protocolVersion: z.number().int(),
  workspaceRoot: z.string(),
  clientId: z.string(),
});
export const HandshakeResult = z.object({
  protocolVersion: z.number().int(),
  orchestratorVersion: z.string(),
  pid: z.number().int(),
  /** True when this client attached to a daemon that already existed. */
  reattached: z.boolean(),
});

export const CreateRunParams = z.object({
  ticketKey: z.string(),
  summary: z.string().optional(),
  /** Workflow name (§21). Falls back to the configured default. */
  workflow: z.string().optional(),
  profile: PipelineProfile.optional(),
  baseRef: z.string().optional(),
});

export const ListWorkflowsResult = z.object({
  workflows: z.array(z.object({
    name: z.string(),
    displayName: z.string().optional(),
    description: z.string(),
    builtIn: z.boolean(),
    runnable: z.boolean(),
    agents: z.record(z.string(), z.object({ model: z.string(), effort: z.string() })),
    issues: z.array(z.object({ rule: z.string(), severity: z.string(), message: z.string() })),
    path: z.string().optional(),
  })),
});
export type ListWorkflowsResult = z.infer<typeof ListWorkflowsResult>;
export const CreateRunResult = z.object({ run: Run });

/**
 * Listing pull requests for review (§6.1, §7.7).
 *
 * `labels` is a discriminated filter rather than an optional array, because
 * "tagged with X" and "carrying no labels at all" are different questions —
 * an empty array would be ambiguous between them, and "untriaged" is the one
 * people actually want.
 */
export const PrLabelFilter = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('any') }),
  z.object({ kind: z.literal('tagged'), labels: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('untagged') }),
]);

export const ListPullRequestsParams = z.object({
  labels: PrLabelFilter.default({ kind: 'any' }),
  state: z.enum(['open', 'closed', 'all']).default('open'),
  reviewRequested: z.boolean().default(false),
  author: z.string().optional(),
  limit: z.number().int().positive().max(100).default(30),
  /** Supplied by the extension host from `SecretStorage`; the daemon has none. */
  token: z.string().optional(),
});

export const PullRequestSummary = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  labels: z.array(z.string()),
  draft: z.boolean(),
  updatedAt: z.string(),
});

export const ListPullRequestsResult = z.object({
  repo: z.object({ owner: z.string(), name: z.string() }).optional(),
  pullRequests: z.array(PullRequestSummary),
  /** Set when the list could not be fetched, with what to do about it. */
  problem: z.string().optional(),
});

export const ListLabelsParams = z.object({ token: z.string().optional() });
export const ListLabelsResult = z.object({
  labels: z.array(z.string()),
  problem: z.string().optional(),
});

export const RunIdParams = z.object({ runId: RunId });
export const ListRunsResult = z.object({ runs: z.array(Run) });

export const GetEventsParams = z.object({ runId: RunId, sinceSeq: z.number().int().nonnegative().default(0) });
export const GetEventsResult = z.object({ events: z.array(z.unknown()) });

export const AnswerQuestionParams = z.object({
  runId: RunId,
  questionId: z.string(),
  choice: z.string().optional(),
  freeText: z.string().optional(),
  deferred: z.boolean().default(false),
});

export const DecideApprovalParams = z.object({
  runId: RunId,
  approvalId: z.string(),
  gate: HumanGate,
  decision: ApprovalDecision,
  note: z.string().optional(),
});

/** The method table. Keys are the wire method names. */
export const Methods = {
  handshake: 'agentflow/handshake',
  shutdown: 'agentflow/shutdown',
  listRuns: 'run/list',
  createRun: 'run/create',
  getRun: 'run/get',
  getEvents: 'run/events',
  startRun: 'run/start',
  pauseRun: 'run/pause',
  cancelRun: 'run/cancel',
  answerQuestion: 'hitl/answer',
  decideApproval: 'hitl/decide',
  listPending: 'hitl/pending',
  listWorkflows: 'workflow/list',
  listPullRequests: 'github/pulls',
  listLabels: 'github/labels',
} as const;

// --- notifications (orchestrator → extension) ------------------------------

export const Notifications = {
  event: 'run/event',
  runUpdated: 'run/updated',
  pendingChanged: 'hitl/pendingChanged',
} as const;

export const RunUpdatedNotification = z.object({ run: Run });
export const PendingChangedNotification = z.object({
  questions: z.array(z.object({ runId: RunId, question: Question })),
  approvals: z.array(ApprovalRequest),
});
export type RunEventNotification = EnvelopedEvent;

export type HandshakeParams = z.infer<typeof HandshakeParams>;
export type HandshakeResult = z.infer<typeof HandshakeResult>;
export type ListPullRequestsParams = z.infer<typeof ListPullRequestsParams>;
export type ListPullRequestsResult = z.infer<typeof ListPullRequestsResult>;
export type ListLabelsParams = z.infer<typeof ListLabelsParams>;
export type ListLabelsResult = z.infer<typeof ListLabelsResult>;
export type PrLabelFilter = z.infer<typeof PrLabelFilter>;
export type CreateRunParams = z.infer<typeof CreateRunParams>;
export type CreateRunResult = z.infer<typeof CreateRunResult>;
export type RunIdParams = z.infer<typeof RunIdParams>;
export type ListRunsResult = z.infer<typeof ListRunsResult>;
export type GetEventsParams = z.infer<typeof GetEventsParams>;
export type AnswerQuestionParams = z.infer<typeof AnswerQuestionParams>;
export type DecideApprovalParams = z.infer<typeof DecideApprovalParams>;
export type RunUpdatedNotification = z.infer<typeof RunUpdatedNotification>;
export type PendingChangedNotification = z.infer<typeof PendingChangedNotification>;
