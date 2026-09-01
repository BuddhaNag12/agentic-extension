import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  EventLog, initialState, replay, transition,
  type Effect, type MachineState, type PipelineOptions, type ReplayState, type Trigger,
} from '@agentflow/core';
import type { NewRunEvent, PipelineProfile, Run, RunEvent } from '@agentflow/protocol';
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
  summary?: string;
  profile?: PipelineProfile;
  baseRef?: string;
}

/**
 * Owns every run in a workspace: their event logs, machine state, and the
 * derived view the UI reads. State is rebuilt by replaying the log on start
 * (§13.2); `state.json` is written only as a read optimization.
 */
export class RunStore extends EventEmitter {
  private readonly runs = new Map<string, RunHandle>();

  constructor(private readonly paths: WorkspacePaths) {
    super();
    this.setMaxListeners(64);
  }

  list(): Run[] {
    return [...this.runs.values()]
      .map((h) => h.run)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get(runId: string): RunHandle | undefined {
    return this.runs.get(runId);
  }

  events(runId: string, sinceSeq = 0): RunEvent[] {
    return this.runs.get(runId)?.log.readSince(sinceSeq) ?? [];
  }

  create(input: CreateRunInput): RunHandle {
    const id = randomUUID();
    const profile = input.profile ?? 'feature';
    const branch = `agentflow/${input.ticketKey}`;
    const now = Date.now();

    mkdirSync(runDir(this.paths, id), { recursive: true });
    const log = EventLog.open(runEventLogPath(this.paths, id));

    const run: Run = {
      id,
      ticket: {
        key: input.ticketKey,
        summary: input.summary ?? input.ticketKey,
        profile,
        tracker: 'manual',
      },
      repo: {
        id: 'default',
        path: this.paths.root,
        baseRef: input.baseRef ?? 'origin/main',
      },
      // §20.2: worktrees live in a sibling directory, not inside the repo —
      // nested worktrees confuse build tooling that resolves from the root.
      worktree: `${this.paths.root}-agentflow/${input.ticketKey}`,
      branch,
      phase: 'intake',
      status: 'queued',
      attemptBudget: { perTask: 4, perRun: 12, maxUsd: 8, maxWallClockMin: 90 },
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
      options: { profile, waitForCi: false },
      derived: replay([]),
    };
    this.runs.set(id, handle);

    this.emitEvent(handle, { t: 'run_created', runId: id, ticketKey: input.ticketKey, branch });
    this.emitEvent(handle, { t: 'phase_entered', phase: 'intake' });
    return handle;
  }

  /** Append an event, update the derived view, and publish it. */
  emitEvent(handle: RunHandle, event: NewRunEvent): RunEvent {
    const stamped = handle.log.append(event);
    handle.derived = replay([stamped], handle.derived);
    handle.run = {
      ...handle.run,
      phase: handle.derived.phase,
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

    if (result.state.phase !== before.phase) {
      this.emitEvent(handle, { t: 'phase_entered', phase: result.state.phase });
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
  restore(): number {
    if (!existsSync(this.paths.runsDir)) return 0;
    let restored = 0;
    for (const id of readdirSync(this.paths.runsDir)) {
      const path = runEventLogPath(this.paths, id);
      if (!existsSync(path)) continue;
      const log = EventLog.open(path);
      const events = log.readAll();
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
        phase: derived.phase,
        status: derived.status,
        attemptBudget: { perTask: 4, perRun: 12, maxUsd: 8, maxWallClockMin: 90 },
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
        machine: { ...initialState(), phase: derived.phase, status: derived.status },
        log,
        options: { profile: 'feature', waitForCi: false },
        derived,
      });
      restored += 1;
    }
    return restored;
  }
}
