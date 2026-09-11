import { join } from 'node:path';
import {
  ClaudeProvider, decompose, runHarvest, runImplement, runPlan, runSpec, topoOrder,
  type AgentProvider, type AgentTurn, type ContextDigest, type Plan, type Spec, type WorkPacket,
} from '@agentflow/agent-runtime';
import { GateRegistry, runGate, type GateAdapter } from '@agentflow/gates';
import { failureSignature, type Effect } from '@agentflow/core';
import type { Step } from '@agentflow/protocol';
import type { WorkspacePaths } from '../paths.js';
import { WorktreeManager } from '../git/worktree.js';
import type { Scheduler } from '../scheduler.js';
import type { RunStore } from './store.js';

/**
 * Drives a run through the real steps (§5). Same surface as the fake driver,
 * so the daemon and every UI view are unchanged — the fake was built to emit
 * exactly these events.
 *
 * Dispatch is per *step*, not per phase: a phase is a pill on the board, and
 * several distinct pieces of work happen inside one. Step work is asynchronous
 * and long. The machine still decides every transition; this only performs the
 * work and reports evidence.
 */

export interface RunArtifacts {
  /** Gates already red on the untouched base (§5.3), excluded from blame. */
  baselineFailures?: string[];
  digest?: ContextDigest;
  spec?: Spec;
  plan?: Plan;
  packets?: WorkPacket[];
  worktree?: string;
  baseSha?: string;
}

export class RealRunDriver {
  private readonly artifacts = new Map<string, RunArtifacts>();
  private readonly cancelled = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly paths: WorkspacePaths,
    private readonly store: RunStore,
    private readonly scheduler: Scheduler,
    private readonly onEffects: (runId: string, effects: Effect[]) => void,
    private readonly provider: AgentProvider = new ClaudeProvider(),
    private readonly gates = new GateRegistry(),
  ) {}

  /**
   * Runs the step the run is *currently* in. Advancing first would skip the
   * head of the pipeline entirely — and preflight is where the worktree is
   * created, so every later step would run against the developer's own
   * checkout instead of an isolated tree (DECISIONS D31).
   */
  start(runId: string): void {
    this.cancelled.delete(runId);
    this.step(runId, { kind: 'start' });
  }

  step(runId: string, trigger: Parameters<RunStore['apply']>[1]): void {
    const result = this.store.apply(runId, trigger);
    if (!result.ok) return;
    this.onEffects(runId, result.effects);

    const handle = this.store.get(runId);
    if (!handle?.machine.step || handle.machine.status !== 'running') return;
    void this.enqueue(runId, handle.machine.step);
  }

  cancel(runId: string): void {
    this.cancelled.add(runId);
  }

  cancelAll(): void {
    for (const runId of this.store.list().map((r) => r.id)) this.cancel(runId);
  }

  /**
   * One step at a time per run, chained rather than dropped. A step advances
   * by calling `step` from inside its own execution, so the next one is always
   * requested while the current is still in flight — dropping it would stall
   * the run after its first step (DECISIONS D32).
   */
  private enqueue(runId: string, step: Step): Promise<void> {
    const prior = this.inFlight.get(runId) ?? Promise.resolve();
    const work = prior
      .then(() => this.runStep(runId, step))
      .catch((err) => this.fail(runId, err))
      .finally(() => {
        if (this.inFlight.get(runId) === work) this.inFlight.delete(runId);
      });
    this.inFlight.set(runId, work);
    return work;
  }

  private async runStep(runId: string, step: Step): Promise<void> {
    if (this.cancelled.has(runId)) return;
    const handle = this.store.get(runId);
    if (!handle) return;

    const workflow = this.store.workflows.workflows.get(handle.run.workflow)?.resolved;
    if (!workflow) {
      return this.block(runId, `workflow "${handle.run.workflow}" is not loadable`);
    }
    const state = this.artifacts.get(runId) ?? {};
    const say = (message: string) =>
      this.store.emitEvent(handle, { t: 'log', level: 'info', message });
    const spend = (usd: number, model: string) =>
      this.store.emitEvent(handle, {
        t: 'cost', usd, inputTokens: 0, outputTokens: 0, model,
      });
    const stream = (turn: AgentTurn) => this.emitTurn(runId, turn);

    switch (step) {
      // --- intake (§5.2) -----------------------------------------------------
      case 'classify':
        // A pasted description is already classified by the chosen workflow;
        // a Jira adapter and a real triage agent land with the Work Inbox.
        say(`starting ${handle.run.ticket.key} on the ${handle.run.workflow} workflow`);
        return this.step(runId, { kind: 'advance' });

      case 'map_repo':
        say(`mapped to ${handle.run.repo.path} on ${handle.run.repo.baseRef}`);
        return this.step(runId, { kind: 'advance' });

      // --- preflight (§5.3) --------------------------------------------------
      case 'check_auth':
        // The Agent SDK drives the Claude Code CLI, which resolves its own
        // credentials; Jira/GitHub auth arrives with the integration layer.
        return this.step(runId, { kind: 'advance' });

      case 'worktree': {
        const tree = new WorktreeManager(this.paths.root);
        say(`preparing an isolated worktree for ${handle.run.ticket.key}`);
        const info = await tree.create({
          ticketKey: handle.run.ticket.key,
          baseRef: handle.run.repo.baseRef,
        }).catch(async (err: Error) => {
          // A tree left by an earlier attempt is reused rather than fought over.
          if (!/already exists/.test(err.message)) throw err;
          const path = tree.pathFor(handle.run.ticket.key);
          return { path, branch: tree.branchFor(handle.run.ticket.key), baseRef: handle.run.repo.baseRef, baseSha: await tree.head(path), headSha: await tree.head(path) };
        });
        this.artifacts.set(runId, { ...state, worktree: info.path, baseSha: info.baseSha });
        this.store.emitEvent(handle, {
          t: 'checkpoint', label: `worktree ${info.branch}`, commitSha: info.baseSha,
        });
        return this.step(runId, { kind: 'advance' });
      }

      case 'detect_gates': {
        if (!state.worktree) return this.block(runId, 'no worktree: preflight did not complete');
        const detected = this.gates.detect({ root: state.worktree, files: [] });
        say(detected.length > 0
          ? `gate adapters detected: ${detected.map((a) => a.id).join(', ')}`
          : 'no gate adapter matched this repository');
        return this.step(runId, { kind: 'advance' });
      }

      case 'check_budget':
        say(`budget: $${workflow.budgets.perRunUsd} and ${workflow.budgets.perTicketMinutes} minutes`);
        return this.step(runId, { kind: 'advance' });

      case 'baseline_gates': {
        // §5.3's highest-value check: failures already present on the base are
        // recorded now so the implementer is not blamed for a broken main and
        // does not burn its repair budget chasing them.
        if (!state.worktree) return this.block(runId, 'no worktree: preflight did not complete');
        const { adapters } = this.gates.resolve(workflow.pipeline.gates.required);
        const baseline: string[] = [];
        if (adapters.length === 0) say('no gate adapter for the required gates; baseline unknown');
        for (const adapter of adapters) {
          const report = await this.scheduler.gates.run(() => this.runOne(runId, adapter, state));
          this.store.emitEvent(handle, {
            t: 'gate_result', gate: adapter.id, ok: report.ok,
            durationMs: report.durationMs, report,
          });
          if (!report.ok) baseline.push(adapter.id);
        }
        if (baseline.length > 0) {
          this.store.emitEvent(handle, {
            t: 'log', level: 'warn',
            message: `baseline already failing: ${baseline.join(', ')} — excluded from the blocking set`,
          });
        }
        this.artifacts.set(runId, { ...state, baselineFailures: baseline });
        return this.step(runId, { kind: 'advance' });
      }

      // --- context (§5.4) ----------------------------------------------------
      case 'harvest': {
        if (!state.worktree) return this.block(runId, 'no worktree: preflight did not complete');
        const r = await runHarvest(this.provider, {
          ticketKey: handle.run.ticket.key,
          ticketDescription: handle.run.ticket.summary,
          worktree: state.worktree!,
          workflow,
        }, stream);
        spend(r.usd, workflow.agents.harvest?.model ?? 'sonnet');
        if (!r.ok) return this.block(runId, `harvest failed: ${r.error}`);
        this.artifacts.set(runId, { ...state, digest: r.digest! });
        this.writeArtifact(runId, 'context', 1, r.digest);
        return this.step(runId, { kind: 'advance' });
      }

      case 'draft_spec': {
        const r = await runSpec(this.provider, {
          ticketKey: handle.run.ticket.key,
          ticketDescription: handle.run.ticket.summary,
          digest: state.digest!,
          worktree: state.worktree!,
          workflow,
        }, stream);
        spend(r.usd, workflow.agents.analyst?.model ?? 'opus');
        if (r.error) return this.block(runId, `spec failed: ${r.error}`);
        if (!r.ok) {
          // SPEC_VALID is a gate, not advice: a spec that fails it does not
          // reach a human, who would be asked to approve invented scope.
          return this.block(runId, `SPEC_VALID: ${r.violations.map((v) => `[${v.rule}] ${v.message}`).join('; ')}`);
        }
        this.artifacts.set(runId, { ...state, spec: r.spec! });
        this.writeArtifact(runId, 'spec', 1, r.spec);
        for (const q of r.spec!.openQuestions) {
          this.store.emitEvent(handle, {
            t: 'question_asked',
            question: {
              id: q.id, question: q.question, whyItMatters: q.whyItMatters,
              alreadyChecked: q.alreadyChecked, blocking: q.blocking,
              allowFreeText: true, confidenceWithoutAnswer: 0.5, phase: 'context',
              ...(q.options ? { options: q.options } : {}),
            },
          });
        }
        return this.step(runId, { kind: 'advance' });
      }

      case 'questions':
        // Questions were raised with the spec; G1 parks the run on this step's
        // exit, so there is nothing further to do here.
        return this.step(runId, { kind: 'advance' });

      // --- plan (§5.5) -------------------------------------------------------
      case 'draft_plan': {
        const r = await runPlan(this.provider, {
          ticketKey: handle.run.ticket.key,
          spec: state.spec!, digest: state.digest!,
          worktree: state.worktree!, workflow,
          profile: handle.run.ticket.profile,
        }, stream);
        spend(r.usd, workflow.agents.planner?.model ?? 'opus');
        if (r.error) return this.block(runId, `plan failed: ${r.error}`);
        if (!r.ok) {
          // The planner gets the rule ids back and retries (§5 Stage 4); the
          // machine counts the attempts and escalates on the third.
          return this.step(runId, {
            kind: 'validation_failed',
            rule: r.violations.map((v) => v.rule).join(','),
          });
        }
        this.artifacts.set(runId, { ...state, plan: r.plan! });
        this.writeArtifact(runId, 'plan', 1, r.plan);
        return this.step(runId, { kind: 'advance' });
      }

      case 'validate_plan':
        // PLAN_VALID ran inside `draft_plan`, which is what let a violation
        // retry the planner. Reaching here means it passed; G2 parks the run.
        say('PLAN_VALID passed; the plan is ready for approval');
        return this.step(runId, { kind: 'advance' });

      case 'decompose': {
        const packets = decompose({
          plan: state.plan!, spec: state.spec!, digest: state.digest!, workflow,
        });
        this.artifacts.set(runId, { ...state, packets });
        say(`compiled ${packets.length} work packets in order ${topoOrder(state.plan!.tasks).join(' → ')}`);
        return this.step(runId, { kind: 'advance' });
      }

      // --- build (§5.6) ------------------------------------------------------
      case 'implement': {
        for (const packet of state.packets ?? []) {
          if (this.cancelled.has(runId)) return;
          this.store.emitEvent(handle, { t: 'task_status', taskId: packet.task.id, status: 'active' });

          const r = await runImplement(this.provider, {
            packet, worktree: state.worktree!, workflow,
          }, stream);
          spend(r.usd, workflow.agents.implementer?.model ?? 'sonnet');

          for (const denied of r.denied) {
            this.store.emitEvent(handle, {
              t: 'log', level: 'warn',
              message: `blocked [${denied.rule}] ${denied.command ?? denied.path ?? denied.tool}`,
            });
          }
          if (!r.ok) return this.block(runId, `${packet.task.id} failed: ${r.error}`);

          for (const path of r.filesTouched) {
            this.store.emitEvent(handle, { t: 'file_changed', path, op: 'modify', hunks: 1 });
          }
          this.store.emitEvent(handle, { t: 'task_status', taskId: packet.task.id, status: 'verifying' });
        }
        return this.step(runId, { kind: 'advance' });
      }

      case 'verify': {
        // Deterministic, and it runs the gates the *tasks declared* — not gates
        // inferred from filenames. The check said how; this obeys it.
        const requested = new Set((state.packets ?? []).flatMap((p) => p.gates));
        const { adapters } = this.gates.resolve([...requested]);
        if (adapters.length === 0) {
          say('no gate adapter matched the declared checks; treating as unverified');
          return this.step(runId, { kind: 'gate_failed', gate: 'none' });
        }

        let allGreen = true;
        for (const adapter of adapters) {
          const report = await this.scheduler.gates.run(() => this.runOne(runId, adapter, state));
          this.store.emitEvent(handle, {
            t: 'gate_result', gate: adapter.id, ok: report.ok,
            durationMs: report.durationMs, report,
          });
          if (!report.ok) { allGreen = false; break; }
        }
        return this.step(runId, allGreen
          ? { kind: 'gate_passed', gate: 'all' }
          : { kind: 'gate_failed', gate: 'ladder' });
      }

      case 'repair':
        // The bounded convergence loop is §11 and lands with the correctness
        // engine. Until then a failed gate is a stop, not a silent retry.
        return this.block(runId, 'the repair loop is not implemented yet — gates are red');

      // --- review (§5.7) -----------------------------------------------------
      case 'auto_review':
        // The four-pass cold reviewer lands with the review engine. Until then
        // the run reaches the human with gate evidence and no automated
        // findings — honestly empty rather than a fabricated pass.
        say('automated review is not implemented yet; proceeding on gate evidence alone');
        return this.step(runId, { kind: 'review_findings', blocking: 0 });

      case 'triage_findings':
        say('assembled the diff and gate reports for review');
        return this.step(runId, { kind: 'advance' });

      case 'human_review':
        // G3 parks the run on this step. Nothing runs while a human holds it.
        return;

      // --- ship (§5.8) -------------------------------------------------------
      case 'rebase':
        // Rebase, the re-run of the ladder on the rebased tree, and the PR
        // package are the rest of the deliver slice. Stopping here is the
        // honest outcome rather than reporting a PR that does not exist.
        return this.block(runId, 'ship is not implemented yet — the branch is ready in the worktree');

      case 'push':
      case 'publish':
      case 'notify':
        // Only reachable with autoPush on, which §5.8 leaves off by default.
        return this.block(runId, `${step} is not implemented: push and open the PR yourself`);
    }
  }

  private async runOne(runId: string, adapter: GateAdapter, state: RunArtifacts) {
    const files = (state.packets ?? []).flatMap((p) => p.task.files);
    return runGate(adapter, {
      repo: { root: state.worktree!, files },
      scope: adapter.affectedBy?.(files) ?? { files },
      logDir: join(this.paths.runsDir, runId, 'logs'),
    });
  }

  private emitTurn(runId: string, turn: AgentTurn): void {
    const handle = this.store.get(runId);
    if (!handle) return;
    if (turn.type === 'tool_call') {
      this.store.emitEvent(handle, {
        t: 'tool_call', tool: turn.tool ?? '', toolUseId: turn.toolUseId ?? '',
        summaryLine: `calling ${turn.tool}`,
      });
    } else if (turn.type === 'tool_result') {
      this.store.emitEvent(handle, {
        t: 'tool_result', toolUseId: turn.toolUseId ?? '',
        ok: turn.ok ?? true, summaryLine: turn.summary ?? '',
      });
    }
  }

  private writeArtifact(runId: string, kind: 'context' | 'spec' | 'plan', version: number, body: unknown): void {
    const handle = this.store.get(runId);
    if (!handle) return;
    const path = join(this.paths.runsDir, runId, 'artifacts', `${kind}.v${version}.json`);
    try {
      const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
      mkdirSync(join(this.paths.runsDir, runId, 'artifacts'), { recursive: true });
      writeFileSync(path, JSON.stringify(body, null, 2), 'utf8');
    } catch { /* the event log is the record; the file is a convenience */ }
    this.store.emitEvent(handle, { t: 'artifact_written', kind, version, path });
  }

  private block(runId: string, reason: string): void {
    const handle = this.store.get(runId);
    if (handle) {
      this.store.emitEvent(handle, { t: 'error', scope: 'phase', message: reason, retryable: false });
    }
    this.store.apply(runId, { kind: 'blocked', reason });
  }

  private fail(runId: string, err: unknown): void {
    this.block(runId, err instanceof Error ? err.message : String(err));
  }
}

/** Kept so a green ladder still records a signature the repair loop can compare. */
export const GREEN = failureSignature([]);
