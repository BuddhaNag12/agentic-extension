import type {
  ApprovalRequest, ArtifactKind, ArtifactRef, CostLedger,
  Phase, Question, RunEvent, RunStatus, TaskStatus,
} from '@agentflow/protocol';

/**
 * The fold from event log to run state (§3.3). `state.json` is only a cached
 * result of this function; deleting it must never lose information.
 */

export interface ChangedFile {
  path: string;
  op: 'create' | 'modify' | 'delete';
  hunks: number;
}

export interface ReplayState {
  runId?: string;
  ticketKey?: string;
  branch?: string;
  phase: Phase;
  status: RunStatus;
  phasesVisited: Phase[];
  artifacts: Partial<Record<ArtifactKind, ArtifactRef>>;
  tasks: Record<string, { status: TaskStatus; attempts: number }>;
  openQuestions: Question[];
  answeredQuestions: string[];
  pendingApprovals: Pick<ApprovalRequest, 'id' | 'gate'>[];
  changedFiles: Record<string, ChangedFile>;
  gateResults: { gate: string; ok: boolean; durationMs: number; signature: string }[];
  checkpoints: { label: string; commitSha?: string | undefined; messageUuid?: string | undefined; at: number }[];
  cost: CostLedger;
  lastError?: { scope: string; message: string; retryable: boolean };
  lastSeq: number;
  startedAt?: number;
  updatedAt: number;
}

export function emptyState(): ReplayState {
  return {
    phase: 'intake',
    status: 'queued',
    phasesVisited: [],
    artifacts: {},
    tasks: {},
    openQuestions: [],
    answeredQuestions: [],
    pendingApprovals: [],
    changedFiles: {},
    gateResults: [],
    checkpoints: [],
    cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
    lastSeq: -1,
    updatedAt: 0,
  };
}

/** Apply one event. Pure and total: an unknown event must never throw. */
export function apply(state: ReplayState, e: RunEvent): ReplayState {
  const s: ReplayState = { ...state, lastSeq: Math.max(state.lastSeq, e.seq), updatedAt: e.at };

  switch (e.t) {
    case 'run_created':
      return { ...s, runId: e.runId, ticketKey: e.ticketKey, branch: e.branch, startedAt: e.at };

    case 'phase_entered':
      return {
        ...s,
        phase: e.phase,
        phasesVisited: s.phasesVisited.at(-1) === e.phase ? s.phasesVisited : [...s.phasesVisited, e.phase],
      };

    case 'status_changed':
      return { ...s, status: e.status };

    case 'artifact_written':
      return {
        ...s,
        artifacts: {
          ...s.artifacts,
          [e.kind]: { kind: e.kind, version: e.version, path: e.path, schemaVersion: '1.0.0', editedByHuman: false },
        },
      };

    case 'question_asked':
      return { ...s, openQuestions: [...s.openQuestions, e.question] };

    case 'question_answered':
      return {
        ...s,
        openQuestions: s.openQuestions.filter((q) => q.id !== e.questionId),
        answeredQuestions: [...s.answeredQuestions, e.questionId],
      };

    case 'approval_requested':
      return { ...s, pendingApprovals: [...s.pendingApprovals, { id: e.approvalId, gate: e.gate }] };

    case 'approval_decided':
      return { ...s, pendingApprovals: s.pendingApprovals.filter((a) => a.id !== e.approvalId) };

    case 'task_status':
      return {
        ...s,
        tasks: {
          ...s.tasks,
          [e.taskId]: { status: e.status, attempts: e.attempt ?? s.tasks[e.taskId]?.attempts ?? 0 },
        },
      };

    case 'file_changed':
      return {
        ...s,
        changedFiles: {
          ...s.changedFiles,
          // A file created then modified stays "create" — the diff against the
          // baseline is what the reviewer sees, not the last operation.
          [e.path]: {
            path: e.path,
            op: s.changedFiles[e.path]?.op === 'create' && e.op === 'modify' ? 'create' : e.op,
            hunks: (s.changedFiles[e.path]?.hunks ?? 0) + e.hunks,
          },
        },
      };

    case 'gate_result':
      return {
        ...s,
        gateResults: [...s.gateResults, { gate: e.gate, ok: e.ok, durationMs: e.durationMs, signature: e.report.signature }],
      };

    case 'checkpoint':
      return { ...s, checkpoints: [...s.checkpoints, { label: e.label, commitSha: e.commitSha, messageUuid: e.messageUuid, at: e.at }] };

    case 'cost':
      return {
        ...s,
        cost: {
          usd: s.cost.usd + e.usd,
          inputTokens: s.cost.inputTokens + e.inputTokens,
          outputTokens: s.cost.outputTokens + e.outputTokens,
        },
      };

    case 'error':
      return { ...s, lastError: { scope: e.scope, message: e.message, retryable: e.retryable } };

    case 'tool_call':
    case 'tool_result':
    case 'log':
      return s;
  }
}

export function replay(events: Iterable<RunEvent>, from: ReplayState = emptyState()): ReplayState {
  let s = from;
  for (const e of events) s = apply(s, e);
  return s;
}
