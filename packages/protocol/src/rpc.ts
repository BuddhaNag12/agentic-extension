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
export type CreateRunParams = z.infer<typeof CreateRunParams>;
export type CreateRunResult = z.infer<typeof CreateRunResult>;
export type RunIdParams = z.infer<typeof RunIdParams>;
export type ListRunsResult = z.infer<typeof ListRunsResult>;
export type GetEventsParams = z.infer<typeof GetEventsParams>;
export type AnswerQuestionParams = z.infer<typeof AnswerQuestionParams>;
export type DecideApprovalParams = z.infer<typeof DecideApprovalParams>;
export type RunUpdatedNotification = z.infer<typeof RunUpdatedNotification>;
export type PendingChangedNotification = z.infer<typeof PendingChangedNotification>;
