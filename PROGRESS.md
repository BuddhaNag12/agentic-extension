# Progress

Where AgentFlow actually stands. `README.md` describes what the thing *is*;
`DECISIONS.md` records *why* each choice was made. This file is the running
answer to "what is done, what is next, and what is blocked on me".

Last updated: 2026-09-21 · `78482f5` · 431 tests across 24 files, typecheck
clean, `.vsix` 990 KB.

---

## Status at a glance

| Area | State |
|---|---|
| Pipeline (7 phases, 23 steps) | Complete, with `Step` granularity and G1/G2/G3 at step exits |
| Event log + replay | Complete. Schema 2.0.0; pre-2.0.0 migrated on read, never rewritten |
| Transport (JSON-RPC over socket) | Complete, with version handshake and stale-build detection |
| Daemon lifecycle | Complete — survives window reloads (fixed 2026-09-21) |
| Git worktrees, checkpoints, rebase | Complete |
| Gate adapters + runner | Complete for Node/TS; five adapters wired |
| Repair loop | Complete, with thrash detection and budget enforcement |
| Reviewer (single pass) | Complete. §5.7's four narrow passes not started |
| Dashboard (editor tab webview) | Complete |
| Work Inbox (Jira + GitHub polling) | Complete |
| PR review pipeline | Complete end to end |
| Publishing findings to GitHub | **Not started** |
| Eval harness (§18.3) | **Not started** |

---

## Done

### The pipeline
Seven phases condensed from the 1.0 draft's longer list, with a `Step` layer
underneath so the three human gates land at step exits rather than phase
boundaries. Legacy logs keep working: ten retired phase names map to steps on
read, and an event with no equivalent is counted and logged rather than
silently dropped by a narrowed enum.

### Real execution
`harvest`, `draft_spec` and `draft_plan` run against real models through the
Agent SDK — verified against this repository at $1.54 a run, producing a
three-task DAG with zero gate violations. The SDK is ESM-only and the `.vsix`
ships no `node_modules`, so it is vendored beside the bundle.

### Gates and repair
Five adapters (compile, lint, unit, coverage, secretscan) with real parsers.
A gate whose tool never ran cannot be called green. A gate already red on the
base is reported but not counted against the run. A red gate now drives a
repair loop with failure-signature thrash detection and a per-run budget,
rather than blocking.

### Review
A single reviewer pass returns real findings; G3 shows the diff, gate evidence
and those findings. The PR review pipeline runs end to end against
`refs/pull/N/head` with a merge-base diff, on a pipeline that correctly
requires only G3.

### UI
The dashboard is an editor tab, not a side panel: every run as a swimlane with
its phases lit, decisions waiting on you with inline approve/answer, and the
selected run's live activity. The Work Inbox polls Jira (300s) and GitHub
(120s) with jitter, caches to disk, and keeps the last good result on failure.

### Reliability work, 2026-09-21
Three defects found by reading the extension host log rather than by a failing
test — the class of bug that a green suite cannot see.

- **Stale daemon after upgrade.** A daemon from an older build answers, so
  nothing looks broken, while every request the new extension added goes to a
  process that has never heard of it. The lockfile now records a build id and
  a mismatch forces a restart. A lock with *no* build id is stale by
  definition.
- **Clean disconnects reported as failures** (`73849ff`). VS Code disposes
  output channels during teardown before disposing us, so a socket error in
  that window logged into a dead channel. Nothing was registered on
  `connection.onError` either, so a write that lost its socket mid-flight
  escaped as an unhandled `EPIPE`. Both now land somewhere.
- **A window reload killed the daemon** (`78482f5`). The headline one, and
  false since the daemon existed. It logged to `process.stderr` — a pipe held
  by the extension host that spawned it. Reloading exits that host and closes
  the read end; the next log line raised a fatal `EPIPE`. The next line is
  `client attached`, so the new window's own connection was what finished it
  off, taking any in-flight run with it. The daemon now logs to
  `.agentflow/orchestrator.log` (rotated one generation past 2MB) and guards
  its standard streams. `daemonSurvival.test.ts` spawns the real entry point,
  closes the pipes underneath it and reconnects; verified to fail against the
  unfixed daemon.

---

## Next

In the order I would take them.

1. **Publish findings as a GitHub review.** The reviewer produces findings and
   nothing carries them to the PR. Read-only by construction today, which was
   deliberate — a module that cannot write cannot be made to write by
   accident — so this is a new, human-triggered surface. Never `APPROVE`.
2. **§7.3 merge-base gate delta.** Gate results are absolute; a review wants
   what *this PR* changed, not what the branch inherited.
3. **§5.7's four narrow review passes.** One pass exists. The remaining three
   are the difference between a reviewer and a linter.
4. **Eval harness (§18.3).** Nothing measures whether review quality moves
   when a prompt changes.
5. **Live diff `FileSystemProvider` (§12.2)** — view a run's changes without
   leaving the editor.
6. **Flake handling (§14.4)** and the **`behaviour_preservation` adapter.**

---

## Blocked on a decision

Each of these enables a gate or a release step and is a judgement call, not a
task. Nothing proceeds on them without an answer.

- **Root `tsconfig.json`** — there is none; each package carries its own.
- **ESLint config** — the `lint` adapter has nothing to run.
- **`gitleaks`** (`brew install gitleaks`) — the `secretscan` adapter is
  installed but the tool is absent.
- **`@vitest/coverage-v8` and a threshold** — the `coverage` adapter cannot
  report without it, and the threshold is a policy choice.
- **A `LICENSE`** — required before publishing, and deliberately not mine to
  pick. `vsce package` runs with `--skip-license` until one exists.

---

## Known drift

- The architecture doc renumbered its sections in this revision. Source
  comments carry **493 `§x.y` references across 136 files**; an unknown but
  large share of them still point at the 1.0 draft's numbering. Nothing has
  cross-checked them against the current doc yet, so treat any `§` in a
  comment as a hint, not an address. The 1.0 draft's §21–§23 were dropped by
  the rewrite and survive as Appendices C–E, since the code implements them.
- Three stale worktrees left by earlier runs: `AF-10`, `FWERP-3191`,
  `FWERP-3706`.

---

## Working notes

- **Install, then reload — in that order.** `code --install-extension` does not
  affect running windows; VS Code reads the extension list once at
  extension-host startup. A reload that races an install lands on the wrong
  side of it and the extension appears not to have installed at all. Confirm
  with `grep -l buddhanag12.agentflow ~/Library/Application\ Support/Code/logs/*/window*/exthost/exthost.log`.
- **The daemon's log is `.agentflow/orchestrator.log`.** When a daemon dies,
  read it first. Before it existed there was no record anywhere of why.
