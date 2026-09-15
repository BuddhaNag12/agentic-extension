import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClaudeProvider, claudeAuthStatus, claudeCliPath, decompose, runHarvest, runImplement, runPlan, runSpec, topoOrder,
  type AgentProvider, type AgentTurn, type ContextDigest, type Plan, type Spec, type WorkPacket,
} from '@agentflow/agent-runtime';
import { GateRegistry, runGate, type GateAdapter } from '@agentflow/gates';
import { failureSignature, type Effect } from '@agentflow/core';
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
          const mark = await tree.checkpoint(state.worktree!);
          this.store.emitEvent(handle, {
            t: 'checkpoint', label: `before ${packet.task.id}`,
            ...(mark ? { commitSha: mark } : {}),
          });

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
              this.store.emitEvent(handle, {
                t: 'task_status', taskId: packet.task.id, status: 'repairing',
              });
              return this.step(runId, { kind: 'gate_failed', gate: adapter.id });
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
            return this.step(runId, { kind: 'gate_failed', gate: adapter.id });
          }
        }
        return this.step(runId, { kind: 'gate_passed', gate: 'all' });
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
