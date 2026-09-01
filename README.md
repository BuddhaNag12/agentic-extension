# AgentFlow

A ticket goes in. A reviewed, tested, green pull request comes out — with a
human approving at three defined points and able to interrupt at any point.

Implementation of [agentflow-architecture.md](agentflow-architecture.md).
**Current state: M0 (skeleton) complete.**

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
- 56 tests: state machine, replay (including a property test), failure
  signatures, concurrency, and a daemon integration test over the real socket

Not yet real: model calls, git worktrees, gate execution, Jira/Figma/GitHub.
Those are M1 and M2.

## Layout

| Package | Owns | Never imports |
|---|---|---|
| `protocol` | zod schemas, RPC contract — single source of truth | anything |
| `core` | domain model, state machine, event log, replay | `vscode`, the Agent SDK |
| `orchestrator` | daemon: scheduling, gates, brokers, persistence | `vscode` |
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

Decisions taken while building this, including the six open questions from
§20, are recorded in [DECISIONS.md](DECISIONS.md).

## Next: M1

A single-ticket vertical slice — Jira read, two harvest subagents, spec, plan,
manual decompose, one implemented task, compile + unit gates, a real commit
and a pushed branch, one real worktree.

The exit criterion is the one that matters: **one real, simple ticket becomes a
real PR.** Do not proceed to M2 until that is genuinely useful on a real
ticket, not a toy one.
