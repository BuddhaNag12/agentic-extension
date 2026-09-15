import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClaudeProvider, claudeAuthStatus, claudeCliPath, decompose,
  runHarvest, runImplement, runPlan, runRepair, runReview, runSpec, topoOrder,
  type AgentProvider, type AgentTurn, type ContextDigest, type Plan, type Spec, type WorkPacket,
} from '@agentflow/agent-runtime';
import { GateRegistry, runGate, type GateAdapter } from '@agentflow/gates';
import type { GateReport, ResolvedWorkflow } from '@agentflow/protocol';
import { classifyAttempt, failureSignature, shouldEscalate, type Effect } from '@agentflow/core';
import type { Step } from '@agentflow/protocol';
import type { WorkspacePaths } from '../paths.js';
import { WorktreeManager } from '../git/worktree.js';
import type { Scheduler } from '../scheduler.js';
import { prPackage } from './prPackage.js';
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
  /** What the last write touched — the diff rung 1 of §11.2 reasons about. */
  lastTouched?: readonly string[];
  /** Per-task `git stash create` sha, taken before the task edited anything.
   *  Rung 4 rewinds to it, so it has to outlive the step that took it. */
  taskCheckpoints?: Record<string, string>;
  /** What `verify` was red on when it handed off to the repair step. */
  repairing?: { gate: string; failures: GateReport['failures']; taskId: string };
  /** How many times review has sent the change back to build (§5.7). */
  reviewRounds?: number;
  /** Gates already red on the untouched base (§5.3), excluded from blame. */
  baselineFailures?: string[];
  /** Required gates whose adapter does not apply here (§5.3), recorded so
   *  their absence is visible rather than silent. */
  undetectedGates?: string[];
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
    const threshold = workflow.pipeline.gates.coverageThreshold;

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
      case 'check_auth': {
        // §5.3 exists because most agent-run failures are environmental, and
        // finding one at minute 25 wastes both money and trust. A missing CLI
        // is exactly that: without this check it surfaces three steps later as
        // a spawn failure inside harvest, which reads like a code problem.
        //
        // Jira/GitHub auth joins this list with the integration layer.
        const cli = claudeCliPath();
        if (!cli) {
          return this.block(
            runId,
            'the Claude Code CLI is not on PATH. Install it, or set ' +
            'AGENTFLOW_CLAUDE_PATH to the `claude` binary.',
          );
        }

        const auth = await claudeAuthStatus(cli);
        if (auth.state === 'signed_out') return this.block(runId, auth.detail);
        if (auth.state === 'unknown') {
          // Not evidence of being signed out, so it warns rather than blocks.
          say(`could not confirm CLI authentication (${auth.detail}); continuing`);
        }
        say(`driving the Claude Code CLI at ${cli}`);
        return this.step(runId, { kind: 'advance' });
      }

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
        const required = workflow.pipeline.gates.required;
        const { adapters, missing } = this.gates.resolve(required);

        // §5.3 separates two failures the registry used to conflate, and the
        // difference decides whether a run may start at all.
        //
        // No adapter for a required gate means *the system* cannot run what
        // this workflow declares. Letting that pass would report
        // ALL_GATES_GREEN over a gate that never existed — a `bug` run would
        // claim success having never run its reproduction test, which is the
        // whole point of the profile.
        if (missing.length > 0) {
          return this.block(
            runId,
            `the "${handle.run.workflow}" workflow requires ${missing.join(', ')}, ` +
            'which no gate adapter implements. Remove it from the workflow or ' +
            'implement an adapter — a declared gate that cannot run is not a gate.',
          );
        }

        // An adapter that exists but does not detect means *this repo* does not
        // support it. §5.3 says warn and continue; it is recorded so the gate's
        // absence is visible rather than inferred from a shorter list later.
        const repo = { root: state.worktree, files: [] };
        const undetected = adapters.filter((a) => !a.detect(repo)).map((a) => a.id);
        const runnable = adapters.filter((a) => a.detect(repo)).map((a) => a.id);

        say(runnable.length > 0
          ? `gate adapters detected: ${runnable.join(', ')}`
          : 'no gate adapter matched this repository');
        if (undetected.length > 0) {
          this.store.emitEvent(handle, {
            t: 'log', level: 'warn',
            message:
              `not runnable in this repository and will be skipped: ${undetected.join(', ')}. ` +
              'The run cannot be verified against them.',
          });
        }
        this.artifacts.set(runId, { ...state, undetectedGates: undetected });
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
        const adapters = this.runnableGates(workflow.pipeline.gates.required, state.worktree);
        const baseline: string[] = [];
        if (adapters.length === 0) say('no gate applies to this repository; baseline unknown');
        for (const adapter of adapters) {
          const report = await this.scheduler.gates.run(
            () => this.runGateIn(runId, adapter, state.worktree!, [], threshold),
          );
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
      //
      // The task cycle lives here rather than in the state machine. §5.6 cycles
      // implement → verify → repair *per task* in DAG order, and doing that at
      // the FSM level would need the task list in `MachineState`. What matters
      // is the ordering, and it is load-bearing: implementing every task before
      // verifying any of them would make each task's gates read a tree
      // containing the next task's half-finished work, and `git add` at commit
      // time would sweep those files into the wrong commit. The step names stay
      // the phase's shape for the board; `verify` is the whole-tree gate.
      case 'implement': {
        const tree = new WorktreeManager(this.paths.root);
        for (const packet of state.packets ?? []) {
          if (this.cancelled.has(runId)) return;
          this.store.emitEvent(handle, { t: 'task_status', taskId: packet.task.id, status: 'active' });

          // Checkpoint *before* the task edits (§5.6). `git stash create`
          // builds a commit object without touching the tree, so this is the
          // sha §11.2's rewind restores to — a repair loop with nothing to
          // rewind to can only go forwards.
          // `git stash create` yields nothing on a clean tree, and the tree is
          // clean before a task starts — the previous task committed. So the
          // checkpoint would have been absent exactly when rung 4 needs it.
          // HEAD *is* the right mark for "before this task": rewinding to it
          // discards the task's uncommitted work and nothing else.
          const mark = (await tree.checkpoint(state.worktree!)) ?? (await tree.head(state.worktree!));
          this.store.emitEvent(handle, {
            t: 'checkpoint', label: `before ${packet.task.id}`,
            ...(mark ? { commitSha: mark } : {}),
          });
          if (mark) {
            const prior = this.artifacts.get(runId) ?? {};
            this.artifacts.set(runId, {
              ...prior,
              taskCheckpoints: { ...prior.taskCheckpoints, [packet.task.id]: mark },
            });
          }

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
          this.artifacts.set(runId, { ...this.artifacts.get(runId), lastTouched: r.filesTouched });

          // This task's own gates, on the tree as this task left it.
          this.store.emitEvent(handle, { t: 'task_status', taskId: packet.task.id, status: 'verifying' });
          const adapters = this.runnableGates(packet.gates, state.worktree!);
          if (adapters.length === 0) {
            // A task whose declared check has no adapter is unverified, and
            // unverified is a failure — never a pass by absence (D16).
            say(`no gate adapter matched ${packet.task.id}'s declared checks`);
            return this.step(runId, { kind: 'gate_failed', gate: 'none' });
          }
          for (const adapter of adapters) {
            const report = await this.scheduler.gates.run(
              () => this.runGateIn(runId, adapter, state.worktree!, packet.task.files, threshold),
            );
            this.store.emitEvent(handle, {
              t: 'gate_result', gate: adapter.id, ok: report.ok,
              durationMs: report.durationMs, report,
            });
            if (!report.ok && !this.wasRedAtBaseline(runId, adapter.id)) {
              // Repair this task here rather than leaving the step: the commit
              // must not happen until it is green, and the tasks after it have
              // not been written yet (DECISIONS D38).
              const fixed = await this.repairLoop({
                runId, packet, workflow,
                gate: adapter.id,
                failures: report.failures,
                rerun: async () => {
                  const out: GateReport[] = [];
                  for (const a of this.runnableGates(packet.gates, state.worktree!)) {
                    out.push(await this.scheduler.gates.run(
                      () => this.runGateIn(runId, a, state.worktree!, packet.task.files, threshold),
                    ));
                  }
                  return out;
                },
                stream, spend,
              });
              if (!fixed.ok) return this.escalate(runId, packet.task.id, fixed);
              break;
            }
          }

          // §5.6: the commit happens per task, *after* its gates pass, so the
          // history is bisectable and a red task leaves the green ones landed.
          const sha = await this.commitTask(runId, tree, packet, state);
          this.store.emitEvent(handle, { t: 'task_status', taskId: packet.task.id, status: 'done' });
          if (sha) {
            this.store.emitEvent(handle, {
              t: 'checkpoint', label: `${packet.task.id} committed`, commitSha: sha,
            });
          }
        }
        return this.step(runId, { kind: 'advance' });
      }

      case 'verify': {
        // ALL_GATES_GREEN is about the whole tree, not the last task: two tasks
        // can each pass their own gates and still break each other. Every task
        // is already committed and green on its own by the time this runs.
        const files = (state.packets ?? []).flatMap((p) => p.task.files);
        const { missing } = this.gates.resolve(workflow.pipeline.gates.required);
        // Preflight already refused this, so reaching it means the registry
        // changed underneath the run. ALL_GATES_GREEN is a claim about the
        // *required* set, and it cannot be made without one of them.
        if (missing.length > 0) {
          return this.block(runId, `cannot claim ALL_GATES_GREEN: no adapter for ${missing.join(', ')}`);
        }
        const adapters = this.runnableGates(workflow.pipeline.gates.required, state.worktree!);
        if (adapters.length === 0) {
          say('no gate adapter matched the required gates; the tree is unverified');
          return this.step(runId, { kind: 'gate_failed', gate: 'none' });
        }
        for (const adapter of adapters) {
          const report = await this.scheduler.gates.run(
            () => this.runGateIn(runId, adapter, state.worktree!, files, threshold),
          );
          this.store.emitEvent(handle, {
            t: 'gate_result', gate: adapter.id, ok: report.ok,
            durationMs: report.durationMs, report,
          });
          if (!report.ok && !this.wasRedAtBaseline(runId, adapter.id)) {
            // A whole-tree failure leaves the step, because it is not any one
            // task's problem — two tasks that each passed their own gates can
            // still break each other. The machine moves to `repair`, which is
            // what puts it on the board.
            this.artifacts.set(runId, {
              ...this.artifacts.get(runId),
              repairing: {
                gate: adapter.id,
                failures: report.failures,
                taskId: (state.packets ?? []).at(-1)?.task.id ?? 'tree',
              },
            });
            return this.step(runId, { kind: 'gate_failed', gate: adapter.id });
          }
        }
        return this.step(runId, { kind: 'gate_passed', gate: 'all' });
      }

      case 'repair': {
        // Whole-tree repair. The per-task loop runs inside `implement`, where
        // the commit is still pending; this one runs against the ladder, and on
        // success STEP_AFTER sends the run back to `verify` rather than onward
        // — a repaired tree that skipped verification would reach review
        // unverified.
        const pending = state.repairing;
        const packet = (state.packets ?? []).find((pk) => pk.task.id === pending?.taskId)
          ?? (state.packets ?? []).at(-1);
        if (!pending || !packet) {
          return this.block(runId, 'the repair step was entered with nothing recorded as failing');
        }

        const fixed = await this.repairLoop({
          runId, packet, workflow,
          gate: pending.gate,
          failures: pending.failures,
          rerun: async () => {
            const out: GateReport[] = [];
            const files = (state.packets ?? []).flatMap((pk) => pk.task.files);
            for (const a of this.runnableGates(workflow.pipeline.gates.required, state.worktree!)) {
              out.push(await this.scheduler.gates.run(
                () => this.runGateIn(runId, a, state.worktree!, files, threshold),
              ));
            }
            return out;
          },
          stream, spend,
        });
        if (!fixed.ok) return this.escalate(runId, packet.task.id, fixed);

        const { repairing: _done, ...rest } = this.artifacts.get(runId) ?? {};
        this.artifacts.set(runId, rest);
        say('repair converged; re-verifying the tree');
        return this.step(runId, { kind: 'advance' });
      }

      // --- review (§5.7) -----------------------------------------------------
      case 'auto_review': {
        if (!state.worktree || !state.baseSha) {
          return this.block(runId, 'no worktree: cannot review a change that is not there');
        }
        const tree = new WorktreeManager(this.paths.root);
        const { patch, truncated } = await tree.diff(state.worktree, state.baseSha);
        if (!patch.trim()) {
          // Nothing to review is not a clean review. It means build produced no
          // diff, which the gates cannot have verified either.
          return this.block(runId, 'there is no diff to review');
        }

        const r = await runReview(this.provider, {
          ticketKey: handle.run.ticket.key,
          spec: state.spec,
          plan: state.plan,
          diff: patch,
          diffTruncated: truncated,
          changedFiles: (await tree.changedFiles(state.worktree, state.baseSha)).map((c) => c.path),
          gateReports: handle.derived.gateResults.map((g) => ({
            gate: g.gate, ok: g.ok, exitCode: g.ok ? 0 : 1,
            durationMs: g.durationMs, failures: [], signature: g.signature,
          })),
          worktree: state.worktree,
          workflow,
        }, stream);
        spend(r.usd, workflow.agents.reviewer?.model ?? 'opus');

        if (!r.ok) {
          // A review that could not run is not a clean review (D16's rule, and
          // the same reasoning): passing the human an empty findings list would
          // read as "nothing wrong" rather than "nobody looked".
          return this.block(runId, `review failed: ${r.error ?? 'unknown'}`);
        }

        this.writeArtifact(runId, 'review', 1, r.report);
        if (r.adversarialUsed) {
          say('first pass found nothing on a large diff; took an adversarial second look (§5.7)');
        }
        for (const f of r.report?.findings ?? []) {
          this.store.emitEvent(handle, {
            t: 'log',
            level: f.severity === 'blocker' || f.severity === 'major' ? 'warn' : 'info',
            message: `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.title}`,
          });
        }
        if (r.unplannedFiles.length > 0) {
          this.store.emitEvent(handle, {
            t: 'log', level: 'warn',
            message: `changed without being planned: ${r.unplannedFiles.join(', ')}`,
          });
        }
        say(
          `review: ${r.blocking} blocking, ` +
          `${(r.report?.findings.length ?? 0) - r.blocking} advisory — ` +
          `plan ${r.report?.planConformance.verdict ?? 'unclear'}`,
        );

        // Blocking findings go back to build as repair work; minor and nit
        // reach the human without stopping the run (§5.7 REVIEW_CLEAR).
        //
        // Bounded, because review → repair → verify → review is a cycle and
        // nothing else closes it: a reviewer that keeps finding the same
        // blocker would otherwise loop until the wall clock or the card did.
        // Past the limit the human decides, which is what G3 is for anyway.
        const round = (state.reviewRounds ?? 0) + 1;
        if (r.blocking > 0 && round > REVIEW_ROUND_LIMIT) {
          this.store.emitEvent(handle, {
            t: 'log', level: 'warn',
            message:
              `review still reports ${r.blocking} blocking finding(s) after ` +
              `${REVIEW_ROUND_LIMIT} repair round(s); handing the decision to you`,
          });
          return this.step(runId, { kind: 'budget_exhausted', which: 'attempts' });
        }

        if (r.blocking > 0 && r.report) {
          const worst = r.report.findings.find((f) => f.severity === 'blocker' || f.severity === 'major')!;
          this.artifacts.set(runId, {
            ...this.artifacts.get(runId),
            reviewRounds: round,
            repairing: {
              gate: 'review',
              taskId: (state.packets ?? []).at(-1)?.task.id ?? 'tree',
              failures: r.report.findings
                .filter((f) => f.severity === 'blocker' || f.severity === 'major')
                .map((f) => ({
                  ...(f.file ? { file: f.file } : {}),
                  ...(f.line !== undefined ? { line: f.line } : {}),
                  rule: f.severity,
                  message: `${f.title} — ${f.evidence} Suggested: ${f.suggestedFix}`,
                })),
            },
          });
          say(`blocking finding: ${worst.title}`);
        }
        return this.step(runId, { kind: 'review_findings', blocking: r.blocking });
      }

      case 'triage_findings':
        say('assembled the diff and gate reports for review');
        return this.step(runId, { kind: 'advance' });

      case 'human_review':
        // G3 parks the run on this step. Nothing runs while a human holds it.
        return;

      // --- ship (§5.8) -------------------------------------------------------
      case 'rebase': {
        const tree = new WorktreeManager(this.paths.root);
        const worktree = state.worktree!;

        // 1. Rebase onto the base. A conflict blocks (§13.3) — auto-resolution
        //    would be a silent semantic change to code approved at G3.
        const rebased = await tree.rebase(worktree, handle.run.repo.baseRef);
        if (!rebased.ok) {
          const where = rebased.conflicts.length > 0
            ? `: ${rebased.conflicts.join(', ')}`
            : '';
          return this.block(runId, `rebase onto ${handle.run.repo.baseRef} conflicted${where} — ${rebased.reason}`);
        }
        say(rebased.alreadyCurrent
          ? `already on top of ${handle.run.repo.baseRef}; nothing to rebase`
          : `rebased onto ${handle.run.repo.baseRef} (${rebased.ontoSha.slice(0, 7)})`);

        // 2. Re-run the ladder. The earlier green was on a different tree, so
        //    it is evidence about a tree that no longer exists.
        const shipFiles = (state.packets ?? []).flatMap((p) => p.task.files);
        const adapters = this.runnableGates(workflow.pipeline.gates.required, worktree);
        for (const adapter of adapters) {
          const report = await this.scheduler.gates.run(
            () => this.runGateIn(runId, adapter, worktree, shipFiles, threshold),
          );
          this.store.emitEvent(handle, {
            t: 'gate_result', gate: adapter.id, ok: report.ok,
            durationMs: report.durationMs, report,
          });
          if (!report.ok && !this.wasRedAtBaseline(runId, adapter.id)) {
            return this.block(runId, `${adapter.id} failed on the rebased tree; the earlier green was a different tree`);
          }
        }

        // 3. Assemble the PR package locally. Nothing leaves the machine.
        const commits = await tree.commitsSince(worktree, rebased.ontoSha);
        if (commits.length === 0) {
          return this.block(runId, 'nothing to ship: the branch has no commits over its base');
        }
        const body = prPackage({
          run: handle.run,
          spec: state.spec,
          plan: state.plan,
          commits,
          diffstat: await tree.diffStat(worktree, rebased.ontoSha),
          gates: handle.derived.gateResults,
          baseSha: rebased.ontoSha,
        });
        const path = this.writeText(runId, 'pr-package.md', body);
        this.store.emitEvent(handle, {
          t: 'artifact_written', kind: 'prpackage', version: 1, path,
        });

        // 4. Hand off. The push is the first irreversible, externally visible
        //    step, and §5.8 leaves it to a human by default.
        say(
          `ready to push: ${handle.run.branch} — ${commits.length} commit(s) over ` +
          `${rebased.ontoSha.slice(0, 7)}. PR body in ${path}`,
        );
        return this.step(runId, { kind: 'advance' });
      }

      case 'push':
      case 'publish':
      case 'notify':
        // Only reachable with autoPush on, which §5.8 leaves off by default.
        return this.block(runId, `${step} is not implemented: push and open the PR yourself`);
    }
  }

  /**
   * Commit one task's work with provenance trailers (§13.1). A task that wrote
   * nothing commits nothing — an empty commit would put a claim in the history
   * that no diff supports.
   */
  private async commitTask(
    runId: string,
    tree: WorktreeManager,
    packet: WorkPacket,
    state: RunArtifacts,
  ): Promise<string | undefined> {
    const handle = this.store.get(runId);
    if (!handle) return undefined;
    // A task that wrote nothing commits nothing: an empty commit would put a
    // claim in the history that no diff supports.
    if (!(await tree.isDirty(state.worktree!))) return undefined;

    return tree.commit(state.worktree!, `${handle.run.ticket.key}: ${packet.task.title}`, {
      'AgentFlow-Run': handle.run.id,
      'AgentFlow-Task': packet.task.id,
      'AgentFlow-Workflow': handle.run.workflow,
    });
  }


  private writeText(runId: string, name: string, body: string): string {
    const dir = join(this.paths.runsDir, runId, 'artifacts');
    const path = join(dir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, body, 'utf8');
    return path;
  }

  /**
   * Was this gate already failing on the untouched base (§5.3)?
   *
   * The baseline run exists precisely so a run does not inherit blame for a
   * broken `main` and burn its repair budget chasing failures it did not
   * cause. Recording the baseline and then still blocking on it would make the
   * check decorative. The failure is still reported as a `gate_result`, so it
   * reaches the human and the PR package either way — it just does not stop
   * the run.
   */
  private wasRedAtBaseline(runId: string, gate: string): boolean {
    const red = this.artifacts.get(runId)?.baselineFailures?.includes(gate) ?? false;
    if (red) {
      const handle = this.store.get(runId);
      if (handle) {
        this.store.emitEvent(handle, {
          t: 'log', level: 'warn',
          message: `${gate} is red, but it was already red on the base — not counted against this run`,
        });
      }
    }
    return red;
  }

  /**
   * Leave the repair loop the way §11.2's rungs 4 and 5 say to.
   *
   * Each exit is a different transition, and the machine owns all three: thrash
   * rewinds the tree and hands the task back to the planner, an exhausted
   * budget parks for a human, and a broken repair blocks. The rewind happens
   * here rather than in the daemon's effect handler because this is what holds
   * the checkpoint sha — an effect handler with no sha could only log.
   */
  private async escalate(
    runId: string,
    taskId: string,
    outcome: { reason: 'thrash' | 'budget' | 'error'; detail: string; signature?: string },
  ): Promise<void> {
    const handle = this.store.get(runId);
    const state = this.artifacts.get(runId);
    if (!handle) return;

    // Why the loop gave up is the first thing a human debugging this needs,
    // and it is not recoverable from the transition alone.
    this.store.emitEvent(handle, {
      t: 'log', level: 'warn',
      message: `repair on ${taskId} escalated (${outcome.reason}): ${outcome.detail}`,
    });
    this.store.emitEvent(handle, { t: 'task_status', taskId, status: 'abandoned' });

    if (outcome.reason === 'thrash') {
      const sha = state?.taskCheckpoints?.[taskId];
      if (sha && state?.worktree) {
        // Rung 4 actually rewinds. Replanning on top of a half-repaired tree
        // would hand the planner a state no plan describes.
        await new WorktreeManager(this.paths.root).restore(state.worktree, sha)
          .then(() => this.store.emitEvent(handle, {
            t: 'checkpoint', label: `rewound ${taskId} to its pre-task checkpoint`, commitSha: sha,
          }))
          .catch((err: Error) => this.store.emitEvent(handle, {
            t: 'error', scope: 'rewind', message: `could not rewind ${taskId}: ${err.message}`, retryable: false,
          }));
      } else {
        this.store.emitEvent(handle, {
          t: 'log', level: 'warn',
          message: `no checkpoint recorded for ${taskId}; replanning on the tree as it stands`,
        });
      }
      return this.step(runId, { kind: 'thrash_detected', signature: outcome.signature ?? 'unknown' });
    }

    if (outcome.reason === 'budget') {
      return this.step(runId, { kind: 'budget_exhausted', which: 'attempts' });
    }
    return this.block(runId, `repair failed on ${taskId}: ${outcome.detail}`);
  }

  /**
   * The bounded convergence loop (§11).
   *
   * One of these runs wherever a gate goes red, and it is the only thing that
   * may write after a failure. It returns rather than throwing, because every
   * way out of it is a different transition: green resumes, thrash rewinds and
   * replans, an exhausted budget escalates to a human.
   *
   * `rerun` re-runs whatever gates were red — the caller knows whether that is
   * one task's set or the whole tree, and re-running the wrong one would
   * declare victory on a different question than the one that failed.
   */
  private async repairLoop(args: {
    runId: string;
    packet: WorkPacket;
    workflow: ResolvedWorkflow;
    gate: string;
    failures: readonly GateReport['failures'][number][];
    rerun: () => Promise<GateReport[]>;
    stream: (turn: AgentTurn) => void;
    spend: (usd: number, model: string) => void;
  }): Promise<
    | { ok: true }
    | { ok: false; reason: 'thrash' | 'budget' | 'error'; detail: string; signature?: string }
  > {
    const { runId, packet, workflow, rerun, stream, spend } = args;
    const handle = this.store.get(runId);
    if (!handle) return { ok: false, reason: 'error', detail: 'run vanished' };

    const budget = Math.max(1, workflow.budgets.attemptsPerTask);
    // Oldest-first, excluding the attempt being classified (§11.1).
    //
    // Deliberately *not* seeded with the failure that triggered the loop. If it
    // were, a first attempt that changed nothing would read as a repeat and
    // escalate immediately — skipping rung 2, which exists for exactly that
    // case ("the obvious fix did not work, read the test in full"). Thrash is
    // two *attempts* agreeing, not one attempt failing to move the needle.
    const signatures: string[] = [];
    const approaches: string[] = [];
    let gate = args.gate;
    let failures = [...args.failures];

    for (let attempt = 1; attempt <= budget; attempt += 1) {
      if (this.cancelled.has(runId)) return { ok: false, reason: 'error', detail: 'cancelled' };

      this.store.emitEvent(handle, { t: 'task_status', taskId: packet.task.id, status: 'repairing', attempt });

      const r = await runRepair(this.provider, {
        packet,
        worktree: this.artifacts.get(runId)?.worktree ?? '',
        workflow,
        gate,
        failures,
        attempt,
        priorApproaches: approaches,
        recentlyTouched: [...(this.artifacts.get(runId)?.lastTouched ?? [])],
      }, stream);
      spend(r.usd, workflow.agents.repair?.model ?? 'sonnet');

      for (const denied of r.denied) {
        // A refusal here is the anti-pattern layer doing its job (§11.3), and
        // it is the most interesting thing that can happen in a repair.
        this.store.emitEvent(handle, {
          t: 'log', level: 'warn',
          message: `repair blocked [${denied.rule}] ${denied.command ?? denied.path ?? denied.tool}`,
        });
      }
      if (!r.ok) return { ok: false, reason: 'error', detail: r.error ?? 'repair failed' };

      this.store.emitEvent(handle, {
        t: 'log', level: 'info',
        message: `repair attempt ${attempt} (${r.rung}): ${r.report?.diagnosis ?? ''}`,
      });
      if (r.report?.approach) approaches.push(r.report.approach);
      for (const path of r.filesTouched) {
        this.store.emitEvent(handle, { t: 'file_changed', path, op: 'modify', hunks: 1 });
      }

      const reports = await rerun();
      for (const report of reports) {
        this.store.emitEvent(handle, {
          t: 'gate_result', gate: report.gate, ok: report.ok,
          durationMs: report.durationMs, report,
        });
      }

      const red = reports.filter((rep) => !rep.ok && !this.wasRedAtBaseline(runId, rep.gate));
      if (red.length === 0) return { ok: true };

      failures = red.flatMap((rep) => rep.failures);
      gate = red[0]!.gate;

      // §11.1: the signature is the loop's only progress metric. A repeat or an
      // oscillation means more attempts of the same kind will not help, and
      // spending the rest of the budget to prove it is the thrash the budget
      // exists to stop.
      const signature = failureSignature(failures);
      const verdict = classifyAttempt(signatures, signature);
      signatures.push(signature);
      if (shouldEscalate(verdict)) {
        return {
          ok: false, reason: 'thrash', signature,
          detail: `${verdict.kind} of failure signature ${signature} after ${attempt} attempt(s)`,
        };
      }
    }

    return {
      ok: false, reason: 'budget',
      detail: `${budget} repair attempts did not converge on ${packet.task.id}`,
    };
  }

  /**
   * The required gates that can actually run here, cheapest first.
   *
   * Adapters whose `detect()` is false are filtered out rather than run:
   * §5.3's "warn and continue" means the gate does not apply to this repo, and
   * running it anyway produces a spurious red that the baseline then has to
   * excuse — noise standing in for a check that was never possible.
   */
  private runnableGates(required: readonly string[], worktree: string): GateAdapter[] {
    const repo = { root: worktree, files: [] };
    return this.gates.resolve(required).adapters.filter((a) => a.detect(repo));
  }

  private async runGateIn(
    runId: string,
    adapter: GateAdapter,
    worktree: string,
    files: readonly string[],
    coverageThreshold?: number,
  ) {
    const repo = {
      root: worktree,
      files: [...files],
      ...(coverageThreshold !== undefined ? { thresholds: { coverage: coverageThreshold } } : {}),
    };
    return runGate(adapter, {
      repo,
      scope: adapter.affectedBy?.([...files]) ?? { files: [...files] },
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

  private writeArtifact(runId: string, kind: 'context' | 'spec' | 'plan' | 'review', version: number, body: unknown): void {
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

/**
 * How many times review may send a change back to build before the human
 * decides instead (§5.7). Two, matching the re-spec limit: a third round of
 * the same argument is a question for a person, not another attempt.
 */
export const REVIEW_ROUND_LIMIT = 2;

/** Kept so a green ladder still records a signature the repair loop can compare. */
export const GREEN = failureSignature([]);
