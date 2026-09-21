# AgentFlow

A ticket goes in. A reviewed, tested, green pull request comes out — with a
human approving at three defined points and able to interrupt at any point.

Implementation of [agentflow-architecture.md](agentflow-architecture.md).
**Current state: a ticket description becomes a rebased, gate-verified branch
with a PR package ready to push. The repair loop, the cold reviewer and the Work
Inbox are the remaining gaps.**

> **The model proposes; the runner decides.** No phase advances because an agent
> said it was finished. A phase advances because a gate — a deterministic
> command, a schema validation, or a human click — returned success. (§1.4)

## The pipeline

Seven phases (§5.1), with the finer work as a `Step` inside one. Seven pills on
the board; steps in the run detail.

```
Intake ─▶ Preflight ─▶ Context ─▶ Plan ─▶ Build ─▶ Review ─▶ Ship ─▶ (you push)
                          [G1]      [G2]   (loop)    [G3]
```

| Phase | Steps | Gate |
|---|---|---|
| `intake` | `classify`, `map_repo` | — |
| `preflight` | `check_auth`, `worktree`, `detect_gates`, `check_budget`, `baseline_gates` | — |
| `context` | `harvest`, `draft_spec`, `questions` | **G1** |
| `plan` | `draft_plan`, `validate_plan`, `decompose` | **G2** after `validate_plan` |
| `build` | `implement`, `verify`, (`repair`) | — |
| `review` | `auto_review`, `triage_findings`, (`human_review`) | **G3** |
| `ship` | `rebase`, and `push`/`publish`/`notify` only with `autoPush` | hands off |

`build` cycles per task in DAG order — checkpoint, implement, that task's
declared gates, **commit on green** — so history stays bisectable and a failing
task leaves the green ones landed. A red gate enters the repair loop rather than
stopping: the task's own gates repair inline (its commit is still pending), a
whole-tree failure moves to the `repair` step and returns to `verify`. `verify` is then the whole-tree
`ALL_GATES_GREEN` pass, because two tasks can each pass their own gates and
still break each other.

`repair` and `human_review` are entered by a trigger — a red gate, a parked
gate — never by falling off the end of the previous step. Gates hang off a step
exit, not a phase exit, which is what puts `decompose` *after* G2: work packets
are compiled from a plan a human approved, never from one they have not seen.

## What works today

A scripted driver emits the same events a real worker does, so the state
machine, event log, replay, transport, gates and approval plumbing are all
exercised deterministically and for free.

- Extension activates, spawns the orchestrator daemon, and reattaches to it
  across window reloads
- JSON-RPC 2.0 over a unix socket / named pipe, with a version handshake
- Append-only JSONL event log per run; all state derived by replay
- Run state machine with the §5.1 transitions, three human gates, loop limits
  and escalation
- Runs tree, inbox, status bar, and a live run-detail timeline
- Schema 2.0.0, with pre-2.0.0 logs migrated **on read** and never rewritten —
  ten legacy phase names become steps, and a dropped event is counted and
  logged rather than discarded by a narrowed enum

**Real and tested, no credentials needed:**

- **Workflows** (§C) — named YAML definitions with per-role model bindings, the
  W1–W8 validator, inheritance, and the five built-ins expressed as definitions
- **Git worktrees** (§4.1) — one isolated tree per run in a sibling directory,
  base-ref resolution, checkpoints, commit trailers, and the §15.2 resume guard
- **Gates** (§14.2) — the adapter interface, a Node/TypeScript adapter set
  (compile, lint, unit, coverage, secretscan) with real parsers, and a runner
  that fails fast and refuses to call a gate green when the tool never ran.
  A required gate with **no adapter** blocks the run at preflight; one whose
  adapter does not apply to this repo warns; one already red on the base is
  reported but not counted against the run (§5.3)
- **Guardrails** (§9.4, §11.3) — the `PreToolUse` policy: worktree escape,
  path allow/denylists, credential-shape detection, bash policy, and the seven
  §11.3 anti-patterns that let a repair loop fake success
- **Replay model** (§14.7) — recorded transcripts replayed through the *live*
  guardrail hook, so orchestration is testable with no API key
- **ClaudeProvider** (§19.3) — the provider seam against
  `@anthropic-ai/claude-agent-sdk`, with the guardrails wired into `canUseTool`
  and structured output through `outputFormat`
- **Preflight** (§5.3) — deterministic and no model: worktree, gate-adapter
  detection, budget, and the **baseline gate run** so a run never inherits
  blame for a red `main`
- **Harvest** (§5.4) — read-only repository exploration returning a
  schema-validated digest
- **Spec** (§5.4) — the specification, gated by SPEC_VALID: every acceptance
  criterion carries a verbatim quote that is checked against the ticket or the
  digest, so an invented requirement fails the gate
- **Plan** (§5.5) — the task DAG, gated by PLAN_VALID's seven rules: acyclic,
  coverage in both directions, every task machine-checkable, predicted paths
  that exist, repro-test-first for bugs, and a split proposed rather than
  attempted when over budget
- **Decompose** (§5.5) — mechanical, no model: the plan compiles into
  self-contained work packets with per-task path allowlists and touch budgets
- **Implement** (§5.6) — the first step that writes, in a real worktree, with
  the guardrails binding through `PreToolUse`, a checkpoint before each task
  edits, and a commit per task once its gates pass
- **Ship** (§5.8) — rebase onto the base, re-run the ladder **on the rebased
  tree** because the earlier green was a different tree, and assemble
  `artifacts/pr-package.md`. A conflict aborts the rebase and blocks rather
  than being resolved (§13.3). Nothing is pushed: the package is a hand-off
  card with the branch, commit list, diffstat, gate summary, the acceptance
  criteria as a manual checklist, and the `git push` to run yourself

- 396 tests: state machine, replay (including a property test), the schema
  2.0.0 log migration, failure signatures, concurrency, workflow validation,
  real git worktrees and rebases, real gate execution, a ship integration test
  that asserts nothing reaches `origin`, and a daemon integration test over the
  real socket

- **Budgets** (§11.2, §17) — the run's spend, wall clock and repair attempts
  come from its workflow and are checked before every billable step, not after
- **Repair** (§11) — the bounded convergence loop: rungs 1–3 of §11.2's ladder
  (local fix, widen context, rethink on the escalation model in a fresh
  session), failure signatures as the only progress metric, a real rewind to
  the pre-task checkpoint on thrash, and a budget that escalates to a human
  rather than looping

- **Review** (§5.7) — a single cold pass: a fresh, read-only session that sees
  the spec, the approved plan, the diff and the gate reports, and nothing of
  how the change was made. Severity-tagged findings with evidence and a
  suggested fix; blocker and major go back to build as repair work, minor and
  nit reach you without stopping the run. Unplanned files are computed, not
  asked. A large diff that comes back empty gets one adversarial re-review

- **GitHub PR queue** (§6.1, §7.7) — list a repository's pull requests
  filtered by label: all, **tagged** with labels you pick, or **untagged** —
  the untriaged pile. Read-only, on `fetch` with no new dependency; the token
  comes from `SecretStorage`, an environment variable, or `gh`

Not yet real: running a review *against* a PR (the queue is there; §7's
worktree-at-head, claim conformance and merge-base gate run are not), §5.7's
four narrow passes (this is one), the eval harness, the rest of the Work Inbox
(§6), and Jira/Figma.

## Layout

| Package | Owns | Never imports |
|---|---|---|
| `protocol` | zod schemas, RPC contract — single source of truth | anything |
| `core` | domain model, state machine, event log, replay | `vscode`, the Agent SDK |
| `agent-runtime` | guardrails, provider seam, replay model, prompt composition | `vscode` |
| `gates` | gate adapters, parsers, the fail-fast runner | `vscode`, the Agent SDK |
| `orchestrator` | daemon: scheduling, worktrees, brokers, persistence | `vscode` |
| `extension` | VS Code host: activation, commands, views | — |
| `webview` | dashboard React app (M3) | — |

`core` having no VS Code and no SDK imports is a rule worth defending: it is
what makes the state machine unit-testable in milliseconds and keeps a future
CLI or web frontend possible (§19.1).

## Build

```bash
npm install
```

```bash
npm run build
```

Everything else is a separate script, each independently runnable:

| Command | What it does |
|---|---|
| `npm run build` | Compiles all packages, then bundles the extension and the daemon |
| `npm run typecheck` | `tsc -b` across every package; no emit |
| `npm test` | 396 tests (`npm run test:watch` to iterate) |
| `npm run package` | Produces `agentflow.vsix` |
| `npm run clean` | Removes `dist/` and build info |

Node 20+ and git are the only prerequisites. Use **npm**, not yarn — the repo
has a `package-lock.json` and no `yarn.lock`, and two lockfiles drift.

## Run the extension

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with
AgentFlow loaded. In the new window, run **AgentFlow: Start Run from Ticket**
from the command palette, enter a key shaped like `PAY-1423`, and pick a
workflow. The run parks three times waiting for you.

To watch the whole pipeline in seconds rather than minutes:

```bash
export AGENTFLOW_FAKE_TIME_SCALE=0.1
```

The extension drives the **real** steps: starting a run creates a git worktree
in preflight, records the baseline gate result, then runs harvest, draft_spec,
draft_plan, decompose, implement and verify in it, parking at the three human
gates. After G3 it rebases, re-runs the ladder and writes
`.agentflow/runs/<id>/artifacts/pr-package.md` — then stops. **You push.**

Runs bill to your Claude Code account — budget roughly $3 for a small ticket.
To drive the simulated pipeline instead (free, deterministic, for UI work):

```bash
export AGENTFLOW_SIMULATE=1
```

To install it into your own VS Code instead of the dev host:

```bash
npm run package && code --install-extension agentflow.vsix --force
```

The packaged `.vsix` carries its own copy of the Agent SDK under
`dist/vendor/`, because `vsce --no-dependencies` ships no `node_modules` and the
SDK cannot be bundled — it reads `import.meta.url` to find its own files. What
it does **not** carry is the SDK's platform-specific native CLI (192 MB, and it
would make the `.vsix` platform-specific): the run drives the `claude` on your
`PATH` instead, so Claude Code must be installed. `preflight` checks for it and
blocks with a clear message if it is missing.

| Variable | Use |
|---|---|
| `AGENTFLOW_CLAUDE_PATH` | Point at a `claude` binary that is not on `PATH` |
| `AGENTFLOW_SDK_PATH` | Point at an `sdk.mjs` directly, e.g. a local SDK checkout |
| `AGENTFLOW_GITHUB_TOKEN` | GitHub token for the PR queue (or `GITHUB_TOKEN`/`GH_TOKEN`, or `gh auth login`, or **AgentFlow: Set GitHub Token**) |

The CLI must also be **signed in** — `claude auth login`. Being signed into the
Claude Code app is not the same thing: the app holds its own session, and a
spawned CLI uses its own stored credential. `preflight` checks this and blocks
with the fix rather than letting it surface as an authentication error inside
`harvest`.

The extension publishes as **`buddhanag12.agentflow`**. The publisher matters:
`AgentFlow` is an unrelated extension already on the Marketplace, and Marketplace
identity is `publisher.name` — so a sideloaded build published under `agentflow`
can be silently replaced by that extension on an update sweep.

## Run the real phases

These call real models and write to a real git worktree. No API key is needed:
the Agent SDK drives the Claude Code CLI, which resolves its own credentials, so
being signed into Claude Code is enough. **Runs bill to that account** — budget
roughly $1.50 for harvest → spec → plan, plus about $0.35 per implemented task.

`harvest`, `spec` and `plan` are read-only and safe to run against any checkout.
`implement` writes, so give it a worktree:

```javascript
const { ClaudeProvider, runHarvest } = require('@agentflow/agent-runtime');
const { BUILT_IN_WORKFLOWS } = require('@agentflow/core');

const result = await runHarvest(new ClaudeProvider(), {
  ticketKey: 'AF-1',
  ticketDescription: 'Add a Commands pane to the run detail view.',
  worktree: process.cwd(),
  workflow: BUILT_IN_WORKFLOWS.find((w) => w.name === 'feature'),
});
console.log(result.digest.likelyTouchSet);
```

A worktree for a writing phase, isolated from your checkout and sharing its
`node_modules` so gates can run:

```javascript
const { WorktreeManager } = require('@agentflow/orchestrator');
const tree = await new WorktreeManager(process.cwd()).create({
  ticketKey: 'AF-1', baseRef: 'main',
});
```

## Where things live

- Three-tier process split (§2.2) — [daemon.ts](packages/orchestrator/src/daemon.ts), [orchestratorClient.ts](packages/extension/src/client/orchestratorClient.ts)
- The state machine (§5.1, §8.4) — [machine.ts](packages/core/src/fsm/machine.ts)
- Phase and step order (§5.1, §3.1) — [profiles.ts](packages/core/src/fsm/profiles.ts)
- Event log and replay (§3.3) — [log.ts](packages/core/src/events/log.ts), [replay.ts](packages/core/src/events/replay.ts)
- Schema 2.0.0 log migration (§3.3) — [migrate.ts](packages/core/src/events/migrate.ts)
- Failure signatures (§11.1) — [signature.ts](packages/core/src/signature.ts)
- Split semaphores (§4.3) — [scheduler.ts](packages/orchestrator/src/scheduler.ts)
- Question and approval broker (§9) — [hitl.ts](packages/orchestrator/src/hitl.ts)
- Workflow schema and W1–W8 validator (§C) — [validate.ts](packages/core/src/workflow/validate.ts), [loader.ts](packages/core/src/workflow/loader.ts)
- Worktrees, commits and rebase (§4.1, §13, §15.2) — [worktree.ts](packages/orchestrator/src/git/worktree.ts)
- The PR hand-off package (§5.8) — [prPackage.ts](packages/orchestrator/src/runs/prPackage.ts)
- Gate ladder and parsers (§14) — [runner.ts](packages/gates/src/runner.ts), [node.ts](packages/gates/src/adapters/node.ts)
- Tool permissions and anti-patterns (§9.4, §11.3) — [guardrails/](packages/agent-runtime/src/guardrails/)
- Replay model and provider seam (§14.7, §19.3) — [replay.ts](packages/agent-runtime/src/providers/replay.ts)
- Prompt layers (Appendix A) — [compose.ts](packages/agent-runtime/src/prompts/compose.ts)

Decisions taken while building this, including the six open questions from
§20, are recorded in [DECISIONS.md](DECISIONS.md).

## Next

The deliver slice now runs end to end. Two candidates:

- **The single-pass reviewer (§5.7, the rest of §20 M2).** `auto_review` returns
  zero findings honestly rather than faking a pass, so G3 currently shows the
  diff and gate evidence and nothing else. M2 asks for one pass, not §5.7's
  four.
- **The Work Inbox (§20 M1):** Jira and GitHub auth via `SecretStorage`, saved
  queries, the three-group TreeView, readiness chips. Independently shippable,
  and it is what makes the tool something to open every morning.

The repair loop (§11, M3) is the other large gap: a red gate blocks the run
instead of converging. The checkpoint it needs to rewind to is now recorded
before every task, which was the missing prerequisite.

`harvest`, `draft_spec` and `draft_plan` run for real end to end — verified
against this repository for $1.54 a run, producing a three-task DAG with zero
gate violations. A Jira adapter can wait: a pasted ticket description exercises
everything.

Credentials: the Agent SDK drives the Claude Code CLI, which resolves its own
auth, so a developer already signed into Claude Code needs no API key. Runs bill
to that account.

**Known drift:** the architecture doc renumbered its sections in this revision,
so many `§x.y` references in source comments still point at the 1.0 draft's
numbering. The 1.0 draft's §21–§23 were dropped by the rewrite and are
preserved as Appendices C–E, since the code implements them.
