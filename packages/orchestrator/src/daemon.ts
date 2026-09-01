import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { totalmem } from 'node:os';
import {
  createMessageConnection, SocketMessageReader, SocketMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js';
import type { Effect } from '@agentflow/core';
import {
  Methods, Notifications, PROTOCOL_VERSION,
  type AnswerQuestionParams, type CreateRunParams, type DecideApprovalParams,
  type GetEventsParams, type HandshakeParams, type HandshakeResult, type RunIdParams,
} from '@agentflow/protocol';
import { HitlBroker } from './hitl.js';
import { clearLock, writeLock } from './lock.js';
import type { WorkspacePaths } from './paths.js';
import { FakeRunDriver } from './runs/fakeDriver.js';
import { RunStore } from './runs/store.js';
import { Scheduler, limitsForMachine } from './scheduler.js';

export const ORCHESTRATOR_VERSION = '0.0.1';

/**
 * The orchestrator daemon (§2.2). It owns scheduling, the state machine,
 * gates, persistence and approvals, and it never touches the VS Code API.
 * It outlives the extension host: a window reload must not kill a 40-minute
 * run, so clients attach and detach freely.
 */
export class Orchestrator {
  private readonly clients = new Set<MessageConnection>();
  private readonly store: RunStore;
  private readonly scheduler: Scheduler;
  private readonly hitl = new HitlBroker();
  private readonly driver: FakeRunDriver;
  private server?: Server;
  private idleTimer?: NodeJS.Timeout;

  constructor(private readonly paths: WorkspacePaths) {
    this.store = new RunStore(paths);
    this.scheduler = new Scheduler(limitsForMachine(totalmem()));
    this.driver = new FakeRunDriver(
      this.store,
      this.scheduler,
      (runId, effects) => this.handleEffects(runId, effects),
      (runId, question) => this.hitl.ask(runId, question).ok,
    );

    this.store.on('event', (payload) => this.broadcast(Notifications.event, payload));
    this.store.on('runUpdated', (run) => this.broadcast(Notifications.runUpdated, { run }));
    this.hitl.on('pendingChanged', () => this.broadcast(Notifications.pendingChanged, this.pendingPayload()));
  }

  async listen(): Promise<string> {
    const restored = this.store.restore();
    if (restored > 0) log(`restored ${restored} run(s) by replay`);

    // A stale socket from a killed daemon would make bind fail with EADDRINUSE.
    if (process.platform !== 'win32' && existsSync(this.paths.ipcEndpoint)) {
      rmSync(this.paths.ipcEndpoint, { force: true });
    }

    this.server = createServer((socket) => this.attach(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.paths.ipcEndpoint, resolve);
    });

    writeLock(this.paths.lockFile, {
      pid: process.pid,
      endpoint: this.paths.ipcEndpoint,
      startedAt: Date.now(),
      version: ORCHESTRATOR_VERSION,
    });
    return this.paths.ipcEndpoint;
  }

  shutdown(): void {
    this.driver.cancelAll();
    this.hitl.dispose();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const c of this.clients) c.dispose();
    this.clients.clear();
    this.server?.close();
    clearLock(this.paths.lockFile);
    if (process.platform !== 'win32') rmSync(this.paths.ipcEndpoint, { force: true });
  }

  private attach(socket: Socket): void {
    const connection = createMessageConnection(
      new SocketMessageReader(socket),
      new SocketMessageWriter(socket),
    );
    this.clients.add(connection);
    this.register(connection);
    connection.onClose(() => this.detach(connection));
    socket.on('error', () => this.detach(connection));
    connection.listen();
    log(`client attached (${this.clients.size} total)`);
  }

  private detach(connection: MessageConnection): void {
    if (!this.clients.delete(connection)) return;
    connection.dispose();
    log(`client detached (${this.clients.size} remaining)`);
  }

  private register(c: MessageConnection): void {
    c.onRequest(Methods.handshake, (p: HandshakeParams): HandshakeResult => {
      if (p.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `protocol mismatch: client ${p.protocolVersion}, daemon ${PROTOCOL_VERSION}. Reload the window.`,
        );
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        orchestratorVersion: ORCHESTRATOR_VERSION,
        pid: process.pid,
        reattached: this.clients.size > 1 || this.store.list().length > 0,
      };
    });

    c.onRequest(Methods.listRuns, () => ({ runs: this.store.list() }));

    c.onRequest(Methods.getRun, (p: RunIdParams) => ({ run: this.store.get(p.runId)?.run }));

    c.onRequest(Methods.getEvents, (p: GetEventsParams) => ({
      events: this.store.events(p.runId, p.sinceSeq ?? 0),
    }));

    c.onRequest(Methods.createRun, (p: CreateRunParams) => {
      const handle = this.store.create({
        ticketKey: p.ticketKey,
        ...(p.summary ? { summary: p.summary } : {}),
        ...(p.workflow ? { workflow: p.workflow } : {}),
        ...(p.profile ? { profile: p.profile } : {}),
        ...(p.baseRef ? { baseRef: p.baseRef } : {}),
      });
      return { run: handle.run };
    });

    c.onRequest(Methods.startRun, (p: RunIdParams) => {
      this.driver.start(p.runId);
      return { ok: true };
    });

    c.onRequest(Methods.cancelRun, (p: RunIdParams) => {
      this.driver.cancel(p.runId);
      this.store.apply(p.runId, { kind: 'cancel' });
      return { ok: true };
    });

    c.onRequest(Methods.pauseRun, (p: RunIdParams) => {
      this.driver.cancel(p.runId);
      this.store.apply(p.runId, { kind: 'blocked', reason: 'paused by user' });
      return { ok: true };
    });

    c.onRequest(Methods.answerQuestion, (p: AnswerQuestionParams) => {
      const pending = this.hitl.answer(p.questionId);
      if (!pending) return { ok: false };
      const handle = this.store.get(p.runId);
      if (handle) {
        this.store.emitEvent(handle, {
          t: 'question_answered',
          questionId: p.questionId,
          answer: {
            questionId: p.questionId,
            ...(p.choice ? { choice: p.choice } : {}),
            ...(p.freeText ? { freeText: p.freeText } : {}),
            deferred: p.deferred ?? false,
            answeredBy: 'user',
            answeredAt: Date.now(),
          },
        });
      }
      return { ok: true };
    });

    c.onRequest(Methods.decideApproval, (p: DecideApprovalParams) => {
      this.hitl.decide(p.approvalId);
      const handle = this.store.get(p.runId);
      if (handle) {
        this.store.emitEvent(handle, {
          t: 'approval_decided',
          gate: p.gate,
          approvalId: p.approvalId,
          decision: p.decision,
          decidedBy: 'user',
          ...(p.note ? { note: p.note } : {}),
        });
      }
      this.driver.step(p.runId, { kind: 'human_decided', gate: p.gate, decision: p.decision });
      return { ok: true };
    });

    c.onRequest(Methods.listPending, () => this.pendingPayload());

    c.onRequest(Methods.listWorkflows, () => {
      const { workflows } = this.store.reloadWorkflows();
      return {
        workflows: [...workflows.values()].map((w) => ({
          name: w.definition.name,
          ...(w.definition.displayName ? { displayName: w.definition.displayName } : {}),
          description: w.definition.description,
          builtIn: w.definition.builtIn,
          runnable: w.runnable,
          agents: Object.fromEntries(
            Object.entries(w.resolved.agents).map(([role, b]) => [role, { model: b!.model, effort: b!.effort }]),
          ),
          issues: w.issues.map((i) => ({ rule: i.rule, severity: i.severity, message: i.message })),
          ...(w.path ? { path: w.path } : {}),
        })),
      };
    });

    c.onRequest(Methods.shutdown, () => {
      setTimeout(() => this.shutdown(), 50);
      return { ok: true };
    });
  }

  /**
   * Effects are the machine's instructions to the world. Keeping them out of
   * the machine is what makes the transitions pure and testable (§6.4).
   */
  private handleEffects(runId: string, effects: Effect[]): void {
    const handle = this.store.get(runId);
    if (!handle) return;

    for (const effect of effects) {
      switch (effect.kind) {
        case 'request_approval': {
          const artifact =
            effect.gate === 'G1' ? ('spec' as const)
            : effect.gate === 'G2' ? ('plan' as const)
            : ('diff' as const);
          const approval = this.hitl.requestApproval({
            runId,
            gate: effect.gate,
            artifact: { kind: artifact, version: 1, path: `artifacts/${artifact}.v1.json`, schemaVersion: '1.0.0', editedByHuman: false },
            summary: approvalSummary(effect.gate, handle.run.ticket.key),
            decisions: [],
            risks: [],
            cost: { soFarUsd: handle.run.cost.usd, projectedUsd: handle.run.cost.usd * 2.2 },
          });
          this.store.emitEvent(handle, {
            t: 'approval_requested',
            gate: effect.gate,
            approvalId: approval.id,
            artifactKind: artifact,
            artifactVersion: 1,
          });
          break;
        }
        case 'escalate_to_human':
          this.store.emitEvent(handle, { t: 'log', level: 'warn', message: `escalated: ${effect.reason}` });
          break;
        case 'rewind_to_task_checkpoint':
          this.store.emitEvent(handle, { t: 'checkpoint', label: 'rewind to task checkpoint' });
          break;
        case 'run_phase':
          this.hitl.resetPhase(runId, effect.phase);
          break;
        case 'replan':
        case 'finalize':
          break;
      }
    }
  }

  private pendingPayload() {
    const { questions, approvals } = this.hitl.pending();
    return {
      questions: questions.map((q) => ({ runId: q.runId, question: q.question })),
      approvals,
    };
  }

  private broadcast(method: string, params: unknown): void {
    for (const c of this.clients) {
      // A dead client must never break the loop for the live ones.
      try {
        void c.sendNotification(method, params);
      } catch {
        this.detach(c);
      }
    }
  }
}

function approvalSummary(gate: string, ticket: string): string {
  switch (gate) {
    case 'G1': return `${ticket}: confirm the problem statement and resolve open questions.`;
    case 'G2': return `${ticket}: approve the approach and task breakdown before any code is written.`;
    default: return `${ticket}: review the diff, gate results and plan conformance.`;
  }
}

function log(message: string): void {
  process.stderr.write(`[agentflow] ${message}\n`);
}
