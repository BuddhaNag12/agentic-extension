import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_PIPELINE_OPTIONS, EventLog, initialState, isTerminal, loadWorkflows,
  pipelineOptionsFor, replay, transition,
  type Effect, type LoadResult, type MachineState, type PipelineOptions,
  type ReplayState, type Trigger,
} from '@agentflow/core';
import type {
  AttemptBudget, NewRunEvent, PipelineProfile, PullRequestRef, ResolvedWorkflow,
  Run, RunEvent,
} from '@agentflow/protocol';
import { runDir, runEventLogPath, runSnapshotPath, type WorkspacePaths } from '../paths.js';

export interface RunHandle {
  id: string;
  run: Run;
  machine: MachineState;
  log: EventLog;
  options: PipelineOptions;
  derived: ReplayState;
}

export interface CreateRunInput {
  ticketKey: string;
  /** Review a pull request rather than deliver a ticket (§7). */
  pullRequest?: PullRequestRef;
  summary?: string;
  /** Workflow name (§21). Defaults to `feature`. */
  workflow?: string;
  profile?: PipelineProfile;
  baseRef?: string;
}

export const DEFAULT_WORKFLOW = 'feature';

/**
 * The run's budget, taken from its workflow (§21.6).
 *
 * It used to be four literals, so every workflow's budgets were decorative: a
 * `chore` capped at $4 got the same $8 as a `feature`, and the numbers a user
 * edited in their own workflow file changed nothing.
 */
function budgetFor(workflow: ResolvedWorkflow | undefined): AttemptBudget {
  const b = workflow?.budgets;
  return {
    perTask: b?.attemptsPerTask ?? 4,
    perRun: b?.attemptsPerRun ?? 12,
    maxUsd: b?.perRunUsd ?? 8,
    maxWallClockMin: b?.perTicketMinutes ?? 90,
  };
}

/**
 * Owns every run in a workspace: their event logs, machine state, and the
 * derived view the UI reads. State is rebuilt by replaying the log on start
 * (§13.2); `state.json` is written only as a read optimization.
 */
export class RunStore extends EventEmitter {
  private readonly runs = new Map<string, RunHandle>();

  private loaded: LoadResult;

  constructor(private readonly paths: WorkspacePaths) {
    super();
    this.setMaxListeners(64);
    this.loaded = loadWorkflows(paths.agentflowDir);
  }

  /** Re-read `.agentflow/workflows` — called when a definition changes on disk. */
  reloadWorkflows(): LoadResult {
    this.loaded = loadWorkflows(this.paths.agentflowDir);
    this.emit('workflowsChanged');
    return this.loaded;
  }

  get workflows(): LoadResult {
    return this.loaded;
  }

  /**
   * The pipeline shape for a run. An unknown or unrunnable workflow falls back
   * to the default rather than throwing — a bad definition should not make an
   * existing run unresumable.
   */
  private optionsFor(name: string): PipelineOptions {
    const entry = this.loaded.workflows.get(name) ?? this.loaded.workflows.get(DEFAULT_WORKFLOW);
    return entry ? pipelineOptionsFor(entry.resolved) : DEFAULT_PIPELINE_OPTIONS;
  }

  list(): Run[] {
    return [...this.runs.values()]
      .map((h) => h.run)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get(runId: string): RunHandle | undefined {
    return this.runs.get(runId);
  }

  /** A terminal run accepts no further decisions (§5, machine invariant). */
  isFinished(runId: string): boolean {
    const handle = this.runs.get(runId);
    return handle ? isTerminal(handle.machine) : true;
  }

  events(runId: string, sinceSeq = 0): RunEvent[] {
    return this.runs.get(runId)?.log.readSince(sinceSeq) ?? [];
  }

  create(input: CreateRunInput): RunHandle {
    const id = randomUUID();
    // A pull request picks its own workflow and profile: a review run that
    // fell through to `feature` would try to plan and build a change that
    // already exists.
    const workflow = input.workflow ?? (input.pullRequest ? 'pr-review' : DEFAULT_WORKFLOW);
    const profile = input.profile ?? (input.pullRequest ? 'pr-review' : 'feature');
    const branch = input.pullRequest
      ? `pull/${input.pullRequest.number}/head`
      : `agentflow/${input.ticketKey}`;
    const now = Date.now();

    mkdirSync(runDir(this.paths, id), { recursive: true });
    const log = EventLog.open(runEventLogPath(this.paths, id));

    const run: Run = {
      id,
      ticket: {
        key: input.ticketKey,
        summary: input.summary ?? input.pullRequest?.title ?? input.ticketKey,
        profile,
        tracker: input.pullRequest ? 'github' : 'manual',
      },
      ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
      repo: {
        id: 'default',
        path: this.paths.root,
        baseRef: input.baseRef ?? 'origin/main',
      },
      // §20.2: worktrees live in a sibling directory, not inside the repo —
      // nested worktrees confuse build tooling that resolves from the root.
      worktree: `${this.paths.root}-agentflow/${input.ticketKey}`,
      branch,
      workflow,
      phase: 'intake',
      step: 'classify',
      status: 'queued',
      attemptBudget: budgetFor(this.loaded.workflows.get(workflow)?.resolved),
      cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
      createdAt: now,
      updatedAt: now,
      artifacts: {},
      sessions: {},
      tasks: [],
    };

    const handle: RunHandle = {
      id,
      run,
      machine: initialState(),
      log,
      options: this.optionsFor(workflow),
      derived: replay([]),
    };
    this.runs.set(id, handle);

    this.emitEvent(handle, { t: 'run_created', runId: id, ticketKey: input.ticketKey, branch });
    this.emitEvent(handle, { t: 'phase_entered', phase: 'intake' });
    this.emitEvent(handle, { t: 'step_entered', step: 'classify' });
    return handle;
  }

  /** Append an event, update the derived view, and publish it. */
  emitEvent(handle: RunHandle, event: NewRunEvent): RunEvent {
    const stamped = handle.log.append(event);
    handle.derived = replay([stamped], handle.derived);
    handle.run = {
      ...handle.run,
      phase: handle.derived.phase,
      ...(handle.derived.step ? { step: handle.derived.step } : {}),
      status: handle.derived.status,
      cost: handle.derived.cost,
      updatedAt: stamped.at,
    };
    this.emit('event', { runId: handle.id, event: stamped });
    this.emit('runUpdated', handle.run);
    return stamped;
  }

  /**
   * Drive the machine and record what happened. The phase and status events
   * are written *because* the machine moved, so the log and the machine can
   * never disagree.
   */
  apply(runId: string, trigger: Trigger): { ok: true; effects: Effect[] } | { ok: false; reason: string } {
    const handle = this.runs.get(runId);
    if (!handle) return { ok: false, reason: `unknown run ${runId}` };

    const result = transition(handle.machine, trigger, handle.options);
    if (!result.ok) {
      this.emitEvent(handle, {
        t: 'error', scope: 'state_machine', message: result.reason, retryable: false,
      });
      return result;
    }

    const before = handle.machine;
    handle.machine = result.state;

    // Phase before step: a reader folding the log sees the pill move, then
    // what is happening inside it, in that order.
    if (result.state.phase !== before.phase) {
      this.emitEvent(handle, { t: 'phase_entered', phase: result.state.phase });
    }
    if (result.state.step && result.state.step !== before.step) {
      this.emitEvent(handle, { t: 'step_entered', step: result.state.step });
    }
    if (result.state.status !== before.status) {
      this.emitEvent(handle, {
        t: 'status_changed',
        status: result.state.status,
        ...(result.state.blockedReason ? { reason: result.state.blockedReason } : {}),
      });
    }
    this.snapshot(handle);
    return { ok: true, effects: result.effects };
  }

  /** Purely a read cache — deleting it must never lose information (§3.3). */
  private snapshot(handle: RunHandle): void {
    writeFileSync(
      runSnapshotPath(this.paths, handle.id),
      JSON.stringify({ run: handle.run, machine: handle.machine, derived: handle.derived }, null, 2),
      'utf8',
    );
  }

  /**
   * Rebuild every run by replaying its log (§13.2). Deliberately does not read
   * `state.json`: if replay and the snapshot ever disagree, replay is right.
   */
  restore(): { restored: number; migrated: number; dropped: number } {
    const summary = { restored: 0, migrated: 0, dropped: 0 };
    if (!existsSync(this.paths.runsDir)) return summary;
    for (const id of readdirSync(this.paths.runsDir)) {
      const path = runEventLogPath(this.paths, id);
      if (!existsSync(path)) continue;
      const log = EventLog.open(path);
      const events = log.readAll();
      summary.migrated += log.migrations.migrated;
      summary.dropped += log.migrations.dropped;
      if (events.length === 0) continue;

      const derived = replay(events);
      const created = events.find((e) => e.t === 'run_created');
      if (!created || created.t !== 'run_created') continue;

      const run: Run = {
        id,
        ticket: { key: created.ticketKey, summary: created.ticketKey, profile: 'feature', tracker: 'manual' },
        repo: { id: 'default', path: this.paths.root, baseRef: 'origin/main' },
        worktree: `${this.paths.root}-agentflow/${created.ticketKey}`,
        branch: created.branch,
        workflow: DEFAULT_WORKFLOW,
        phase: derived.phase,
        ...(derived.step ? { step: derived.step } : {}),
        status: derived.status,
        attemptBudget: budgetFor(this.loaded.workflows.get(DEFAULT_WORKFLOW)?.resolved),
        cost: derived.cost,
        createdAt: created.at,
        updatedAt: derived.updatedAt,
        artifacts: derived.artifacts,
        sessions: {},
        tasks: [],
      };

      this.runs.set(id, {
        id,
        run,
        machine: {
          ...initialState(),
          phase: derived.phase,
          ...(derived.step ? { step: derived.step } : {}),
          status: derived.status,
        },
        log,
        options: this.optionsFor(DEFAULT_WORKFLOW),
        derived,
      });
      summary.restored += 1;
    }
    return summary;
  }
}
