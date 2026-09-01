import { z } from 'zod';
import {
  Answer, ApprovalDecision, ArtifactKind, GateId, GateReport, HumanGate,
  Phase, Question, RunId, RunStatus, TaskStatus,
} from './domain.js';

/**
 * The append-only event log (§3.3). UI state, audit trail, resume logic and
 * evals are all derived from this. `state.json` is only a read cache and can
 * be rebuilt by replay at any time.
 */

const base = { seq: z.number().int().nonnegative(), at: z.number() };

export const RunEvent = z.discriminatedUnion('t', [
  z.object({ ...base, t: z.literal('run_created'), runId: RunId, ticketKey: z.string(), branch: z.string() }),
  z.object({ ...base, t: z.literal('phase_entered'), phase: Phase }),
  z.object({ ...base, t: z.literal('status_changed'), status: RunStatus, reason: z.string().optional() }),
  z.object({ ...base, t: z.literal('artifact_written'), kind: ArtifactKind, version: z.number().int(), path: z.string() }),
  z.object({ ...base, t: z.literal('question_asked'), question: Question }),
  z.object({ ...base, t: z.literal('question_answered'), questionId: z.string(), answer: Answer }),
  z.object({ ...base, t: z.literal('approval_requested'), gate: HumanGate, approvalId: z.string(), artifactKind: ArtifactKind, artifactVersion: z.number().int() }),
  z.object({ ...base, t: z.literal('approval_decided'), gate: HumanGate, approvalId: z.string(), decision: ApprovalDecision, decidedBy: z.string(), note: z.string().optional() }),
  z.object({ ...base, t: z.literal('task_status'), taskId: z.string(), status: TaskStatus, attempt: z.number().int().optional() }),
  z.object({ ...base, t: z.literal('tool_call'), tool: z.string(), toolUseId: z.string(), summaryLine: z.string() }),
  z.object({ ...base, t: z.literal('tool_result'), toolUseId: z.string(), ok: z.boolean(), summaryLine: z.string() }),
  z.object({ ...base, t: z.literal('file_changed'), path: z.string(), op: z.enum(['create', 'modify', 'delete']), hunks: z.number().int().nonnegative() }),
  z.object({ ...base, t: z.literal('checkpoint'), label: z.string(), commitSha: z.string().optional(), messageUuid: z.string().optional() }),
  z.object({ ...base, t: z.literal('gate_result'), gate: GateId, ok: z.boolean(), durationMs: z.number(), report: GateReport }),
  z.object({ ...base, t: z.literal('cost'), usd: z.number(), inputTokens: z.number().int(), outputTokens: z.number().int(), model: z.string() }),
  z.object({ ...base, t: z.literal('log'), level: z.enum(['debug', 'info', 'warn']), message: z.string() }),
  z.object({ ...base, t: z.literal('error'), scope: z.string(), message: z.string(), retryable: z.boolean() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent['t'];

/** An event before the log assigns it a sequence number and timestamp. */
export type NewRunEvent = DistributiveOmit<RunEvent, 'seq' | 'at'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Events carry the run they belong to when they cross the RPC boundary. */
export const EnvelopedEvent = z.object({ runId: RunId, event: RunEvent });
export type EnvelopedEvent = z.infer<typeof EnvelopedEvent>;
