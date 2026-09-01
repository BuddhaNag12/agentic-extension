# AgentFlow

A ticket goes in. A reviewed, tested, green pull request comes out — with a
human approving at three defined points and able to interrupt at any point.

Implementation of [agentflow-architecture.md](agentflow-architecture.md).
**Current state: M0 complete; M1's deterministic foundation in place.**

> **The model proposes; the runner decides.** No phase advances because an agent
> said it was finished. A phase advances because a gate — a deterministic
> command, a schema validation, or a human click — returned success. (§1.4)

## What works today

M0 is the skeleton: the pipeline is real, the work inside each phase is not.
A scripted driver emits the same events a real worker will, so the state
machine, event log, replay, transport, gates and approval plumbing are all
exercised end to end before a single model call exists.

- Extension activates, spawns the orchestrator daemon, and reattaches to it
  across window reloads
- JSON-RPC 2.0 over a unix socket / named pipe, with a version handshake
- Append-only JSONL event log per run; all state derived by replay
- Run state machine with the §5 transitions, three human gates, loop limits
  and escalation
- Runs tree, inbox, status bar, and a live run-detail timeline
**Real and tested, no credentials needed:**

- **Workflows** (§21) — named YAML definitions with per-role model bindings, the
  W1–W8 validator, inheritance, and the five built-ins expressed as definitions
- **Git worktrees** (§4.1) — one isolated tree per run in a sibling directory,
  base-ref resolution, checkpoints, commit trailers, and the §13.2 resume guard
- **Gates** (§12.2) — the adapter interface, a Node/TypeScript adapter set with
  real parsers, and a runner that fails fast and refuses to call a gate green
  when the tool never ran

- 133 tests: state machine, replay (including a property test), failure
  signatures, concurrency, workflow validation, real git worktrees, real gate
  execution, and a daemon integration test over the real socket

Not yet real: model calls, Jira/Figma/GitHub. Those need credentials and are
the rest of M1.

## Layout

| Package | Owns | Never imports |
|---|---|---|
| `protocol` | zod schemas, RPC contract — single source of truth | anything |
| `core` | domain model, state machine, event log, replay | `vscode`, the Agent SDK |
| `gates` | gate adapters, parsers, the fail-fast runner | `vscode`, the Agent SDK |
| `orchestrator` | daemon: scheduling, worktrees, brokers, persistence | `vscode` |
| `extension` | VS Code host: activation, commands, views | — |
| `webview` | dashboard React app (M3) | — |

`core` having no VS Code and no SDK imports is a rule worth defending: it is
what makes the state machine unit-testable in milliseconds and keeps a future
CLI or web frontend possible (§17.1).

## Running it

```bash
npm install && npm run build && npm test
```

Then press <kbd>F5</kbd> in VS Code to launch the extension host, and run
**AgentFlow: Start Run from Ticket** from the command palette. Enter any key
shaped like `PAY-1423`, pick a profile, and watch the run walk the pipeline.
It will park three times waiting for you.

To watch the whole pipeline in a few seconds instead of a couple of minutes,
set `AGENTFLOW_FAKE_TIME_SCALE=0.1` in the environment before launching.

## Where things live

- Three-tier process split (§2.2) — [daemon.ts](packages/orchestrator/src/daemon.ts), [orchestratorClient.ts](packages/extension/src/client/orchestratorClient.ts)
- The state machine (§5, §6.4) — [machine.ts](packages/core/src/fsm/machine.ts)
- Event log and replay (§3.3) — [log.ts](packages/core/src/events/log.ts), [replay.ts](packages/core/src/events/replay.ts)
- Failure signatures (§9.1) — [signature.ts](packages/core/src/signature.ts)
- Split semaphores (§4.3) — [scheduler.ts](packages/orchestrator/src/scheduler.ts)
- Question and approval broker (§7) — [hitl.ts](packages/orchestrator/src/hitl.ts)
- Workflow schema and W1–W8 validator (§21) — [validate.ts](packages/core/src/workflow/validate.ts), [loader.ts](packages/core/src/workflow/loader.ts)
- Worktrees (§4.1, §13.2) — [worktree.ts](packages/orchestrator/src/git/worktree.ts)
- Gate ladder and parsers (§12) — [runner.ts](packages/gates/src/runner.ts), [node.ts](packages/gates/src/adapters/node.ts)

Decisions taken while building this, including the six open questions from
§20, are recorded in [DECISIONS.md](DECISIONS.md).

## Next: the rest of M1

What is left needs credentials: a Jira adapter reading a real ticket, the
agent-runtime wrapper around the Claude Agent SDK, and the harvest/spec/plan
phases calling real models. The deterministic pieces those plug into — the
workflow that configures them, the worktree they write in, and the gates that
judge them — are done and tested.

The exit criterion is the one that matters: **one real, simple ticket becomes a
real PR.** Do not proceed to M2 until that is genuinely useful on a real
ticket, not a toy one.

To set up credentials when you are ready:

```bash
export ANTHROPIC_API_KEY=...   # or run: ant auth login
```
