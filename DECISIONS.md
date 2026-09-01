# Decisions

Every §-reference points at `agentflow-architecture.md`. Each decision names
where it is encoded, so reversing one is a code change with a known blast
radius rather than an archaeology exercise.

## The six open decisions from §20

### D1 — Autonomy default: all three gates mandatory

Ships with G1, G2 and G3 all required. No trusted profile, no auto-approve, no
setting that removes a gate. Autonomy gets earned with §16.3 data, not assumed.

*Encoded in:* `HUMAN_GATE_AT` in [machine.ts](packages/core/src/fsm/machine.ts).
A gated phase cannot leave without a `human_decided` trigger, and there is no
code path that synthesizes one.

*Reversing it later:* add a per-profile gate set to `PipelineOptions`. The
machine already treats "gate satisfied" as state, so this is additive.

### D2 — Worktree location: sibling directory

`<repo>-agentflow/<TICKET-KEY>`, not `.agentflow/worktrees/`. Build tooling
that resolves paths from the repo root gets confused by nested worktrees, and
the gitignore discipline required by the nested option is a permanent tax.

*Encoded in:* `RunStore.create` in [store.ts](packages/orchestrator/src/runs/store.ts).
Configurable in M1 when real worktrees exist.

### D3 — Tests: local in the loop, CI as pre-ship truth

L0–L3 run locally inside the repair loop, because a 40-second local unit run is
what makes the loop converge. CI is the authority before Gate 3, because CI is
what the merge gate actually runs.

*Encoded in:* a `wait_for_ci` phase sits between `review` and `human_review` in
the `Phase` enum and `PHASE_ORDER`, gated by `PipelineOptions.waitForCi`,
defaulting to **off** until M2 ships a real `ship` phase.

The phase exists now on purpose: adding a phase to a state machine with a
persisted event log later is meaningfully more expensive than carrying a
skipped one.

### D4 — Ticket sizing: reject with a suggested split

A ticket over the estimated-edit budget is rejected at plan validation with a
proposed decomposition, rather than attempted. Auto-splitting into linked
sub-tickets is deferred.

*Status:* **recorded, not yet implemented.** The plan validator lands in M1;
this is rule 7 of `PLAN_VALID` (§5 Stage 4). Nothing in M0 enforces it.

### D5 — The human's uncommitted work: explicit base ref

Runs branch from `origin/<base>` so local WIP is invisible to the agent, which
is the right default. "Base this run on my current branch" is expressible
rather than a special case: `RepoRef.baseRef` is a first-class field and
`CreateRunParams.baseRef` plumbs it through from the UI.

*Encoded in:* `RepoRef` in [domain.ts](packages/protocol/src/domain.ts).

### D6 — Multi-repo: one repo in v1, not one repo by definition

§20.6 warns that retrofitting is expensive, so the identifiers are
repo-qualified now even though nothing reads them yet:

- `RepoId` exists as a distinct type, and `RepoRef` carries an `id`.
- `Task.repo` is an optional `RepoId` defaulting to the run's single repo.

Adding a second repo becomes an additive schema change rather than a break in
a persisted event log. `Run.repo` stays singular until v2 actually needs it —
speculatively pluralizing it would complicate every call site today to buy
nothing.

## Decisions made while building M0

### D7 — Human gates are evaluated on phase *exit*, not entry

§5's state diagram gates the transitions *out of* `clarify`, `plan` and
`human_review`. So a gated phase is entered normally, does its work, and only
then parks in `waiting_human`. Gating on entry would park the run before the
artifact the human is meant to judge exists.

### D8 — A loop-back clears the gate it invalidates

`MachineState.gatesPassed` is cleared for the relevant gate whenever the run
loops backward: a scope change clears G1, thrash-driven replanning clears G2,
a "request revision" clears its own gate. Without this, a revised plan would
sail past Gate 2 on the strength of an approval given to a different plan —
which is exactly how gates become theatre (§7.1).

### D9 — An illegal transition is an error, never a silent no-op

`transition()` returns `{ok: false, reason}` rather than ignoring a trigger it
does not expect, and the orchestrator writes that reason to the event log. A
swallowed trigger is how a run stalls forever with a spinner and no
explanation.

### D10 — Replay is authoritative; `state.json` is only a cache

`RunStore.restore()` deliberately does not read `state.json`. If replay and the
snapshot ever disagree, replay is right. The snapshot exists to make the first
paint fast, and deleting it must never lose information (§3.3). A property test
asserts `replay(snapshot) ≡ fold(events)` for arbitrary event sequences.

### D11 — A spike keeps all three gates

§5.10 says a spike skips Implement and Ship. It is silent on review. The call:
a spike skips `implement`, `verify`, `review` (there is no diff for an
automated code review to read) but **keeps** `human_review`, where the gate's
question becomes "are these findings good?" rather than "is this code I would
merge". This keeps the three-gate invariant uniform across every profile and
gives the spike a real terminus.

### D12 — Questions route through the broker, never straight to the log

An agent asking a question calls the broker, which applies the §7.2 cap and the
`alreadyChecked` requirement and *may refuse*. Only an accepted question is
written to the event log. Logging first would make the cap unenforceable, since
the UI renders from the log.

## Decisions made building M1's foundation

### D13 — A "profile that skips Q&A" keeps its phase and its gate

§5.10 says `chore` and `refactor` skip clarify. Taken literally that drops G1
with it, which collides with D1's three mandatory gates — and W6 caught the
contradiction the first time the built-in workflows were validated.

The resolution: those workflows keep the `clarify` phase and set
`maxQuestionsPerPhase: 0`. The phase runs, asks nothing, records its assumptions,
and presents the spec for a fast confirmation. What a chore skips is the
*questions*, not the *gate* — which is what §5.10's parenthetical "(unless
questions are blocking)" was already pointing at.

### D14 — The workflow definition is the only source of pipeline shape

`PipelineOptions` used to be `{profile, waitForCi}` with a `PROFILES` table in
`core`, duplicating what the workflow files now say. It is now
`{skip, waitForCi, forceClarify?}`, projected from a workflow by
`pipelineOptionsFor()`. Two places defining which phases exist is exactly the
kind of drift that produces a run whose UI and state machine disagree.

### D15 — Gates resolve binaries from `node_modules/.bin`, never `npx`

`npx tsc` in a project without TypeScript installed fetches a **decoy package**
of that name from the registry and runs it — and once cached, `--no-install`
serves it too. A gate would then execute code the repo never depended on and
report a stranger's exit code as the build result.

Adapters resolve `node_modules/.bin/<tool>` and fall back to PATH, and `detect()`
requires the local package to be present. A repo without the toolchain simply
does not have that gate, which is the honest answer.

### D16 — A gate that could not run is a failure, never a pass

A missing binary, a timeout, or non-zero exit with unparseable output all
produce a failing `GateReport` with a specific reason. Returning "no failures"
for a gate that never executed is the precise shape of the false green §16.3
names as the trust metric.

### D17 — The failure signature covers the whole set, not the reported slice

Only the top 20 failures reach a model (§5 Stage 7), but the §9.1 signature
hashes all of them. Signing the truncated slice would make fixing failure 21
look like zero progress, and the repair loop would escalate on phantom thrash.
