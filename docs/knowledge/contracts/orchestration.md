# Orchestration contract

Nucleus's durable orchestration rules. The deployment boundary is the standalone
service in [Contract 007](service-boundary.md); these rules hold across the
plugin-to-service cutover. Specs own the detailed design and acceptance oracles.
Where installed behaviour differs from an approved direction, both are stated
and labelled.

## Invariants

- Owner verbs refuse only to protect four invariants (Tom, 2026-10-19):
  - exact-head review before merge, or an explicit recorded operator source
    acceptance of that exact head (Tom, 2026-10-20; see
    [Operator source acceptance](#operator-source-acceptance));
  - callback authentication: a stopped or replaced run never reports as current;
  - durable side effects: an effect with unknown delivery is never re-run
    blindly;
  - task and PR identity.

  Every refusal names its invariant and the verb that clears it.
- Anything else in the way is the verb's job: it stops and settles the owning
  run, then does what was asked. Settling Nucleus's own bookkeeping (episodes,
  incidents, notices, leases) belongs to the verb, never to an intermediate
  coordinator report or manual lease release (Tom, 2026-10-27). Recovery work
  corrects shared lifecycle behaviour instead of adding an exception per stuck
  shape.
- No single-stuck-state fixes (Tom, 2026-10-14,
  [AGENTS.md](../../../AGENTS.md#papercuts)): a stuck task is cleared with a
  [Spec 050](../specs/050-owner-task-controls.md) owner verb, the verb is
  generalized, or the case waits for the reconciler. Promoting a papercut never
  authorizes a narrow guard, proof tuple or exception-specific control.
- A record bound to a superseded participant never fences current work (Tom,
  2026-11-01): an incident, notice, delivery, effect or recorded result that
  names a released run is history, so it can neither refuse, reclassify nor
  supply the actionable text for the run that replaced it. Its record and any
  unknown-delivery evidence stay readable and are never resent, and the owner
  verb that supersedes it settles it with the other fences it supersedes.
- When work has progressed beyond an earlier recovery episode and no run or
  attention still owns it, reconciliation settles the stale episode before
  advancing that work. Explicit planner and owner waits remain in force.
- Persist external-operation intent before acting. Reconcile an ambiguous result
  instead of blindly creating another workspace, agent, PR comment or merge.
- Observation is not authority. A plan, projection, read or `next` view grants
  no review, merge or execution authority; applying a control re-derives current
  facts. A failed, timed-out, incomplete or unreadable observation is
  `unverified`, never absence, and a missing or malformed field is unknown,
  never a different value.
- Local checkout `git status` reads use the slow local-Git bound, asynchronously,
  so they delay the task that needs them rather than the executor's other work.
  Exact-head identity is read from the filesystem inside a transaction or send
  guard. If Node reports that it terminated such a read on timeout, Nucleus keeps
  the task in an environment wait naming the command and timeout, then retries on
  a later pass; the timeout is never a clean result or a task incident. A real
  non-zero Git exit retains its existing handling, and a dirty result still
  refuses the operation.
- Nucleus refuses any task write whose resultant record fails the task schema; the
  write rolls back. A committed change whose board projection fails reports an
  uncertain outcome; the caller reads current state and Nucleus never replays it
  ([Spec 013](../specs/013-standalone-queue-service.md)).
- Owner verbs apply while Nucleus is paused (Tom, 2026-10-19). Task state changes
  at once; only dispatch of new agents waits for unpause. A continuation on an
  already-bound run is in-flight settlement and proceeds during pause.
- Tasks needing attention stay owned until resolved or explicitly disposed of.
  Nucleus never invents a planning decision, and a document never grants
  execution authority.

## Daemon owners

The [architecture](../architecture.md) names each file. This section is the
rule map a later port works from: for each owner, what it owns, the durable
rules it enforces, the named pure decisions, remaining same-name delegates, and
which strings are control flow. Topic sections below still own those rules;
this section names who enforces them.

Engine and Resolution keep a same-name method for every moved public method so
instance overrides still fire. A delegate is a plain function that
returns the owner's result. An `async` wrapper adds a microtask turn and
reorders detached wakes against owner reads. Internal callers go through the
shell (`this.resolution.x`, `this.engine.x`). A Resolution owner reads
`this.resolution.adapter` per call; an Engine owner reads `this.engine.adapter`.
Never capture either; never switch which adapter a line used.

`Resolution.adapter` is a Proxy: a settled Task-bearing call fires
`gitTransientRecovered` with source `resolution.<method>`. Failures never
witness; the Proxy tags thrown objects. `Engine.adapter` is a host-routing Proxy
(Queue #912) over the adapter of the host in scope; it never fires, because it
only routes. Engine wiring clears only a due episode whose `source` matches.
Do not unify the two adapters.

Event kinds, reason text, refusal text and typed refusal classes are control
flow. They stay byte-identical. `test/control-strings.test.ts` pins the census.
Do not normalise `store.update` against `Resolution.update` (the latter nulls
`stop`), or `store.events` (newest 100) against `eventsAll` (all, oldest first).
Do not rewrap the typed refusal classes that settle an operation.

### Host-run scheduling

`core/host-runs/host-run-scheduler.ts` owns scheduler identity, authority fencing, the
pump, timers and durable transition writes. Its public methods remain delegates.
`host-run-admission.ts` owns classification, submission and adoption;
`host-run-queue-order.ts` owns priority, aging and repository fairness;
`host-run-capacity.ts` owns capacity charges, budget history and CPU coverage.
`host-run-accounting.ts` owns accounting retirement and its board reads.
`host-run-launch.ts` owns the durable launch boundary and handler handoff;
`host-run-settlement.ts` owns settlement, abandoned reservations and custody
release. Owners call back through the scheduler for shared transitions and
import downward without importing the scheduler. Shared call types live in
`host-run-scheduler-types.ts`. The detached `host-run-supervisor.ts` keeps process
execution and never imports the scheduler owners or Store. Admission order,
refusal text and journal facts remain unchanged.

### Milestone QA

`core/qa/project-qa.ts` owns dispatch, reconciliation and settlement, with delegates
for run reads and supervisor inspection in `project-qa-inspection.ts`, escaped
descendant capacity tracking in `project-qa-escapees.ts`, and file pruning in
`project-qa-supervision-files.ts`. The supervision-files module also owns durable
schemas, run paths, owner-only reads and writes, step logs and file removal.
`project-qa-supervisor.ts` owns the detached pipeline and re-exports the moved
file helpers and TAP collector for existing callers. `project-qa-tap-failures.ts`
owns failure parsing, identities and truncation. These modules import downward;
none imports its former parent, and file helpers have no runtime store dependency.

### Shared task reads

`shared/holds.ts` owns hold projection, blocking fences and task-owner identity.
`shared/disposition.ts` owns disposition policy and cancellation withdrawal reads.
`shared/task-view.ts` owns task projections, run binding and merge-evidence reads,
and exposes the stop helpers from `shared/task-stop.ts`. These modules read
contracts as types only; their runtime dependencies never load the contracts barrel.

`shared/schema/task-primitives.ts` owns the shared task enums and membership
schemas; `shared/schema/task-view.ts` owns the compact task-view schemas.
`shared/schema/` also owns the domain records: tasks and runs, review and
proofs, workspace resolution, projects and repositories, lanes and plans,
leads and papercuts, decisions and questions, settings and capacity, host runs
and QA, and board state. `shared/rpc/` owns the matching domain RPC definitions
and imports those schemas directly. `shared/contracts.ts` re-exports them for
existing callers. Schema modules never import RPC modules; neither layer
imports the contracts barrel, including type imports. Their import graph stays
acyclic; `test/contracts-boundaries.test.ts` checks the direction, cycles,
re-export identity and bridge import gate.

### Shells

**Engine** (`core/engine.ts`). Constructs the owners, supplies late-bound adapter
and method ports, and owns host scope, stop state and compatibility delegates.
`core/scheduling/task-quantum.ts` owns each task's ordered steps and finish work,
including prerequisite waits yielding to live work. Prerequisite release batches
live in `core/scheduling/prerequisites.ts`; settings and planner migration live
in planning, owner-control admission in verbs, retention hooks in hooks and
stop classification in recovery. Phase owners receive only their named ports;
synchronous delegates add no promise turn.

**Resolution** (`core/resolution.ts`). Constructs the phase owners and supplies
named live ports, compatibility delegates and the retry-witness adapter. Ordered
advancement lives in `core/scheduling/lifecycle.ts`: its gates, re-reads after
awaits, run reservation and failure settlement retain their original order.
Review continuation proof belongs to review; orphan-run settlement belongs to
recovery; planner presence and stale-answer delivery belong to questions.

`core/resolution-adapter.ts` owns the retry-witness Proxy, preserving synchronous
returns and reading adapter methods on access. Resolution supplies the error-source
map and a callback that reads its current recovery handler.
`core/recovery/resolution-decisions.ts` owns the pure advance-failure rule.
External-effect classification belongs to `core/verbs/control-decisions.ts`, workspace
admission pacing to `core/workspaces/admission-decisions.ts`, and queued dispatch
ordering to `core/dispatch/queue-order.ts`. Engine and resolution retain their
helper re-exports.

### Scheduling owners

**LaneScheduler** (`core/scheduling/lane-scheduler.ts`). Owns exclusive per-key lane
quanta, `quiesce`, and the shutdown discard of queued quanta. Enforces
[Durable effects](#durable-effects-and-unknown-delivery): only same-lane
re-entry runs inline; a call inside a lane excludes its own lane; delayed
timers do not hold quiesce open. Engine `wake` and `stop` wait through this
`quiesce`. Delegates remain on Engine.

**TaskWakes** (`core/scheduling/task-wakes.ts`). Owns what a task's quantum owes after it
runs: lifecycle, completion and terminal-archive follow-ups, their bounded
retry timers, the git-transient backoff, and the scheduled task quantum.
Enforces the follow-up cadence in [Durable effects](#durable-effects-and-unknown-delivery)
and the git-transient episode close on a successful retry of the failed
resolution operation. Pures: `quantumFollowUps`, `gitTransientPlan`,
`stepFailureRoute`. Engine.stop calls its `stop()`. Delegates remain on Engine.

**Sweep** (`core/scheduling/sweep.ts`). Coalesces reconciliation windows and drains and
conducts the audit pass. Enforces the cursor-sweep as the restart and
missed-signal fallback in [Durable effects](#durable-effects-and-unknown-delivery).
Delegates remain on Engine, including test-facing sweep state accessors.

**ControlContext** (`core/verbs/control-context.ts`). Holds the hidden parameters of
every verb (`selfForceRunId`, `coordinatorActionRunId`, `replayingDeferredVerb`)
and `isOwnerCall`. One object per engine, never module-level. Enforces
[Coordinator and owner verbs](#coordinator-and-owner-verbs) authority that
reads those values. Engine keeps same-name accessors.

**Projections** (`core/store/projections.ts`). Runs what stays outside the delivery
lanes: workspace titles, the cleanup drain and its retry timers,
runtime-retirement scheduling, and the occurrence counts a wake or an effect
retry waits on. Enforces [Cleanup](#cleanup). Engine.stop calls its `stop()`.
Delegates remain on Engine.

### Worker-path owners

**Dispatch** (`core/dispatch/dispatch.ts`). Visits queued tasks, admits workspace
creation and review entry, and owns the workspace-pressure wake. Enforces
[Admission, limits and priority](#admission-limits-and-priority) and
[Review entry](#review-entry). Pures: `dispatchGate`,
`decideWorkspacePressureWait`. Engine.stop clears its timer. Delegates remain
on Engine. `workspaceAdmissionGapMs` and `queuedDispatchOrder` stay exported
from `engine.ts` because tests import them there.

**Admission** (`core/host/admission.ts`). Admits, coalesces and measures every
Paseo call by class. A breaker deferral is a wait-and-retry, never operator
attention (`AdmissionDeferred`). Control-flow string: `BACKPRESSURE_DEFERRAL`.
Enforces [Admission, limits and priority](#admission-limits-and-priority). No
Engine or Resolution delegate: owners read `admissionOf(this.adapter)`.

**WorkerLauncher** (`core/dispatch/worker-launcher.ts`). Creates a task's worker: one
creation per task at a time on each engine, one run identity claimed in a
transaction, then the agent and its launch failures. Enforces
[Runs and callbacks](#runs-and-callbacks) identity at creation. Delegates
remain on Engine.

**WorkspaceProvisioning** (`core/workspaces/workspace-provisioning.ts`). Creates,
compares and removes a task's sibling worktrees, refreshes checkout siblings,
prepares worktree links and reads the stash list. Enforces
[Sibling links and preparation](#sibling-links-and-preparation). Delegates
remain on Engine.

**WorkerReconcile** (`core/recovery/worker-reconcile.ts`). Holds the initial worker's
reconcile pass in steps: observe and settle a live one, look for its branch PR,
repair a split reporting binding, take a blocked return, then accept its
recorded result. Enforces [PR identity from reports](#pr-identity-from-reports)
and [Liveness and reminders](#liveness-and-reminders). Pures:
`classifyWorkerObservation`, `branchPrLookupOutcome`, `blockedReturnDecision`.
Delegates remain on Engine.

**WorkerFailover** (`core/dispatch/worker-failover.ts`). The sweep that replaces an
exhausted or failed worker, and its decision. Enforces
[Worker replacement ceiling](#worker-replacement-ceiling) and
[Retained worker recovery](#retained-worker-recovery). `decideWorkerFailover`
is the pure replacement decision; it is file-private. `planWorkerFailover`
gathers the lazy reads and writes, including the store's typed availability rows.
The replacement ceiling refusal lives with the replacement rule in
`core/recovery/worker-replacement.ts`. Delegates remain on Engine.

**RetiredObservations** (`core/recovery/retired-observation.ts`). The retired-worker
observation cadence and the lifecycle-signal invalidations that make an identity
due before it. Same-name `Engine` methods delegate to it.

**RetiredAgentArchive** (`core/workspaces/retired-agent-archive.ts`). The sweep that
archives retired errored agents so a Paseo workspace stops reporting Failed. An
unreadable read or a refused archive records a thread-archive wait instead of
being dropped. `Engine.archiveRetiredErroredAgents` delegates to it.

**CreationRecovery** (`core/recovery/creation-recovery.ts`). Recovers a proven-absent
worker and an unowned workspace creation, including proof-only dispatch
recovery. Enforces [Orphan worktree after a timed-out create](#orphan-worktree-after-a-timed-out-create)
and [Parked dispatch and workspace repair](#parked-dispatch-and-workspace-repair).
Pures: `workspaceReplayAllowed`, `absentWorkerStep`. Control-flow strings:
`ABSENT_WORKER_REASON`, `PRE_AGENT_LAUNCH_FAILURE_REASON`. Delegates remain on
Engine.

**CallbackIntake** (`core/intake/callback-intake.ts`). Authenticates, validates and
records one report. `CallbackIntake` holds Engine's source gates and the
checkpoint and review-progress receipts. `RunCallbackIntake` holds Resolution's
run completion (validate, proof, build output, bookkeeping, receipt), which
stays synchronous. Enforces [Runs and callbacks](#runs-and-callbacks) and
[Progress checkpoints](#progress-checkpoints). Pures: `completionRoute`,
`completionRefusal`. Engine's `complete`, `completeCheckpoint` and
`completeReviewProgress` delegates return the owner's promise without an
`async` wrapper. Delegates remain on Engine and Resolution.

### Owner-verb owners

**owner-verbs.ts**. Owns the verb registry and compatibility exports. Enforces
[Coordinator and owner verbs](#coordinator-and-owner-verbs) and the four invariants.
The read-side modules under `core/verbs/` import downward, never the registry:
`owner-facts.ts` owns task facts, blockers and wait reasons; `task-next.ts` assembles
`task.next` and `currentReviewOutcome`; `owner-effects.ts`, `owner-restart.ts` and
`owner-move.ts` own their verbs' pure admission and views. `owner-shared.ts` holds
the shared applicability shape, schemas and mapped apply helper. The registry
passes its view function to the task-next assembler. Handlers with I/O remain
in the existing control modules below.

**TaskControlDispatcher** (`core/verbs/dispatcher.ts`). Every task control
enters here: audit lines, force and cap gates, the action switch, the authority
proofs, and the wrappers that wake a task after its verb. Enforces
[Verbs](#verbs). Delegates remain on Engine.

**ForceVerbs** (`core/verbs/force.ts`). Applies `force: true` on
`retry_effect` and `move`: who may force, the settlement record, and the forced
move. Enforces the force rules in [Verbs](#verbs). Pures:
`forceMergeSourceRefusal`, `forceMergeAcceptance`, `forceMergeAdmission`,
`forceMovePatch`. Delegates remain on Engine.

**MoveControls** (`core/verbs/moves.ts`). The owner `move` verb: to work,
review, merge and closeout, and closeout's external-merge reconciliation.
`restart role=worker` passes its arm into `moveToWork` inside that transaction.
Enforces [Retained and replaced readers](#retained-and-replaced-readers),
[Owner acceptance](#owner-acceptance) and
[Operator source acceptance](#operator-source-acceptance). Pure:
`retainedReaderDecision`. Delegates remain on Engine. `ExternalMergeRefusal` is
the typed pre-send refusal this verb throws.

**RestartControls** (`core/verbs/restart.ts`). The owner `restart` verb: every
run shape it continues or replaces, the parked step and escalation answer it
falls back to, the stalled-turn stop and absent-run recovery. Enforces
[Retained worker recovery](#retained-worker-recovery) and the restart arms in
[Verbs](#verbs). Delegates remain on Engine.

**RetryEffectControls** (`core/verbs/retry-effect.ts`). The owner
`retry_effect` verb, by phase: replayed outcomes, branches that answer before
observed-idle settlement, recovery effects and uncertain operations, then fence
settlement and the ordinary effects. Enforces
[Durable effects](#durable-effects-and-unknown-delivery). Delegates remain on
Engine.

**RouteControls** (`core/verbs/route.ts`). The owner `route` verb, its
live-run stop and subscription-group refusal, and the profile checks submission
and brief amendment share. Enforces [Profile selection](#profile-selection) and
[Routing issues](#routing-issues). Pure: `routePatch`. Delegates remain on
Engine.

**OwnerStop** (`core/verbs/owner-stop.ts`). The owner `stop` verb and the hold
it places and yields, records owner verbs to replay once their wait clears, and
continues an awaiting retained reviewer. Enforces
[Holds](#holds) and one-stop-one-resume in [Checkpoints](#checkpoints).
Control-flow string: `OWNER_STOP_HOLD_PREFIX` (`'Owner stop:'`). Delegates
remain on Engine.

**ProofControls** (`core/verbs/proof.ts`) and **proof-activation.ts**.
Activation refusals, preview and release-GO evidence live as pures in
`proof-activation.ts` (`proofActivationRefusal`, `proofActivationPreview`,
`proofGoDecision`). The verb file reads those facts and activates the one
author-side proof execution a task's brief names. Enforces
[Validation and proof](#validation-and-proof) and
[Source-immutable proof executor ruling](#source-immutable-proof-executor-ruling).
Delegates remain on Engine.

**SettingsControls** (`core/verbs/settings.ts`). Owner verbs that change a
task's settings and nothing else: lanes, routing, worker exclusions,
dependencies, notes and holds, completion subscriptions and the task's owner.
Enforces [Lanes](#lanes), [Holds](#holds) and
[Owners and notices](#owners-and-notices). Delegates remain on Engine.

**BriefControls** (`core/verbs/brief.ts`). Re-pins a committed handoff's
instruction, amends a Nucleus-held brief, and refuses brief text that still
declares a stage plan. Enforces
[Submission and instruction source](#submission-and-instruction-source).
Delegates remain on Engine.

**AgentControls** (`core/verbs/agent-controls.ts`). Controls a task's own run
reaches over its authenticated callback, the `*FromAgent` entries and
`authenticateAgentControl`. Enforces [Runs and callbacks](#runs-and-callbacks).
Delegates remain on Engine.

**TaskRemoval** (`core/verbs/removal.ts`). Removes a task from the board,
retries a failed runtime retirement or a skipped build-output cleanup, and
settles the build output a finished run leaves. Enforces [Cleanup](#cleanup).
Delegates remain on Engine.

**TaskCompletion** (`core/verbs/complete.ts`). Finishes a task that has no PR
to merge. Enforces [Closeout and outcomes](#closeout-and-outcomes). Delegates
remain on Engine.

**ReviewerControls** (`core/verbs/reviewer.ts`). Owner verbs that keep or
replace a task's reviewer: `continueRetainedReviewer`,
`preserveRetainedReviewer` and `restartReview`. Enforces
[Retained and replaced readers](#retained-and-replaced-readers). Delegates
remain on Engine.

**PausedStops** (`core/verbs/paused-stops.ts`). Stops every active thread
while Nucleus is paused and resumes each stopped thread in place once it runs
again. Enforces
[Stop active threads while paused](#stop-active-threads-while-paused-queue-650).
Delegates remain on Engine.

**Dispositions** (`core/verbs/disposition.ts`). Cancellation and supersession,
including the operator and bulk entry points. The compatibility surface re-exports
`core/verbs/disposition/`: `requests.ts` owns cancel/supersede fences, withdrawal and
workspace retries; `effects.ts` owns durable intent/results and ordered
reconciliation; `refs.ts` observes origin evidence; `hook-evidence.ts` settles
repeated refusals; `workspace.ts` proves preservation; `production.ts` wires
remote effects; `controls.ts` owns operator and bulk entry points.
`state.ts` owns shared serialization, `types.ts` defines dependencies, and
`read-model.ts` reads stored disposition detail. Board and `task.next` policy
stays in store-free `shared/disposition.ts`. Implementation modules never import
the compatibility surface. Enforces
[Cancellation and disposition](#cancellation-and-disposition). Delegates remain
on Engine.

### Review and merge owners

**MergePhase** (`core/merge/merge-phase.ts`). Restores recorded merge intents,
re-observes unchanged failed checks and sequences exact automatic hook replay.
Merge owners receive narrow contexts; Resolution supplies live delegates and
adapter access, with synchronous calls and promise boundaries preserved.
Enforces [Merge gates](#merge-gates). RecoveryLifecycle retains its replay entry
as a direct promise delegate to this owner, preserving the original async boundary.

**CheckWaits** (`core/merge/check-waits.ts`). Polls pending required checks without
the integration turn, handles the one same-head rerun of runnerless jobs, and
reads merge-gate and required-check evidence against the settings revision.
Enforces [Merge gates](#merge-gates). Delegates remain on Resolution.

**MergeIntent** (`core/merge/merge-intent.ts`). Verifies a durable merge intent
against GitHub and spends its one SHA-guarded re-issue after continuous
non-merge proof. Enforces [Merge gates](#merge-gates). Pures:
`reissueGateDecision`, `mergeObservationDecision`, `mergeProofDecision`,
`mergeIntentDecision`. Delegates remain on Resolution.

**MergeGates** (`core/merge/merge-gates.ts`). Proves the exact-head merge gates: the
reviewed-head and prospective-merge `task.pre_merge` hooks, the refusal that
returns an unchanged head to its worker, the project validation the prospective
candidate runs, and the mechanical gate and source checks. Then records merge
intent and makes the one guarded merge request, re-reading the fence and
settings revision before the intent and again before the send. Enforces
[Merge gates](#merge-gates). Delegates remain on Resolution for
`refusePreMerge`, `verification` and `advanceMerging`.

**ExternalMerge** (`core/merge/external-merge.ts`). Accepts or detects a PR merged
outside Nucleus: the operator accept verb, the automatic probe, and the sweep
that resumes a task parked on a cleared external-merge check. Enforces
[External merge](#external-merge). Control-flow strings:
`EXTERNAL_MERGE_CHECK_REASON_PREFIX`, `EXTERNAL_MERGE_CHECK_RECOVERED_REASON`.
Delegates remain on Resolution.

**IntegrationTurns** (`core/merge/integration-turns.ts`). Each repository's FIFO
integration turn: sequence assignment, claim, who holds the turn, the closeout
reservation that lets a landed merge pass parked verifications, and the quantum
that keeps the turn while a task's awaited work runs. Enforces
[Integration turn](#integration-turn). Delegates remain on Resolution.
`turnReleased` stays a late-bound field on Resolution; Closeout calls it when a
closeout write frees the turn.

**ParticipantLease** (`core/dispatch/participant-lease.ts`). Proves a task's
participants are settled: the lease over identities that still own work, and
the execution lease merge and closeout read, including retained runs and
blocking recovery effects. Enforces
[Terminal participant liveness](#terminal-participant-liveness). Delegates
remain on Resolution.

**Holds** (`core/merge/merge-hold.ts`). Builds hold patches, prompts the owner of a
merge hold that is the last blocker, and lifts self-lifting holds. Enforces
[Holds](#holds). Exports `OWNER_STOP_HOLD_PREFIX`. Delegates remain on
Resolution for `holdLastBlocker` and `reconcileHoldUntil`.

**ResultApplication** (`core/intake/result-application.ts`). Applies a released
result: reviewer, revision, proof-executor, and the interrupted-review reapply
path. Enforces [Verdicts and findings](#verdicts-and-findings) and the
single-apply fence in [Durable effects](#durable-effects-and-unknown-delivery).
Delegates remain on Resolution and return the owner's promise without an
`async` wrapper. A ready revision, agent closeout, applied reviewer verdict or proof-routing
transition and an executor callback write `run_result_applied` for their run in
the same transaction as the task transition; an overlapping
pass cannot clear a successor run. Parked blocker classification, the stop
and `next` read the latest retained author's result. A delegated escalation
stop records the answering planner or decider as the dispatch hold owner.

**ReviewPublication** (`core/review/review-publication.ts`). Classifies the durable
`reviewPublication:<run>` effect and holds formal publication recovery for an
unpublished ordinary reviewer verdict. Enforces
[Publication recovery](#publication-recovery). Delegates remain on Resolution.

**ReviewLifecycle** (`core/review/lifecycle.ts`). Owns reviewer opt-in, continued
PR identity binding, ordinary review custody, source-approval proof waits and
review/revision advancement. Resolution supplies narrow live contexts to this
owner, ReviewContinuations, ReviewPublication and PrAdoption; compatibility
delegates preserve caller overrides and return promises without an async wrapper.

**Closeout** (`core/closeout/closeout.ts`). Selects the closeout authority (queue,
repository hook or agent) and finishes closeout: the queue and hook
completions, the agent's closeout result, the sync to the integration branch,
and the write that hands the turn on. Enforces
[Closeout and outcomes](#closeout-and-outcomes) and
[Repository hooks](#repository-hooks). Delegates remain on Resolution except
the two private helpers `reviewDisclosures` and `closeoutRefreshAllowed`, which
only Closeout calls.

**ProofAutorun** (`core/qa/proof-autorun.ts`). Starts a brief-named proof at an
approved head without a question: wait for re-declared inputs, skip a
docs-only head, or run the existing `proof` route once per head. Enforces
[Validation and proof](#validation-and-proof). Delegates remain on Resolution.

**ReviewContinuations** (`core/review/review-continuation.ts`). Checkpoint and
delivery rules of a retained reviewer, and one authorized reviewer turn.
Enforces [Checkpoints](#checkpoints) and
[Retained and replaced readers](#retained-and-replaced-readers). Pures:
`keepRetainedReviewer`, `retainedReaderStateDecision`, `reviewContinuationState`,
`reviewContinuationWait`, `reviewAuthorizationRequired`. Delegates remain on
Resolution.

**PrAdoption** (`core/review/pr-adoption.ts`). Binds an existing PR to a task:
identity only under an authenticated block, otherwise dead-revision recovery,
initial reconciliation or replacement. Enforces
[PR identity from reports](#pr-identity-from-reports). Delegates remain on
Resolution.

**OwnedTools** (`core/machine/owned-tool.ts`). Proves no live tool holds a run and
records the `owned_tool_*` events. Enforces
[Owned-tool evidence](#owned-tool-evidence). Delegates remain on Resolution.

**SlotAdmission** (`core/dispatch/capacity.ts`). Slot occupancy and fair-share order,
and why a task has no slot now, for one dispatch pass or one board batch.
Enforces [Admission, limits and priority](#admission-limits-and-priority).
Pures: `decideSlotAdmission`, `slotRequestDecision`, `capacityFor`,
`recoveryCapacityFor`, `fairSlotRequestOrder`. Control-flow strings
`CAPACITY_WAIT_PREFIX` and `QA_CAPACITY_WAIT_PREFIX` are defined in
`shared/wait-state.ts`; SlotAdmission and the other slot readers compare them.
Delegates remain on Resolution.

Ordinary reviewer checkout refusals identify the failed identity, ref, or
clean-tree condition and include expected and observed values where available.
Pre-program hook baseline failures retain the occurrence as retryable intent;
Git command errors include the exit code or terminating signal even when
stderr is empty.

When a slot wait names numbered tasks from another repository, it uses the
repository-qualified `repo#N` form; same-repository occupants keep the shorter
`#N` label. A queued proof-only qualification is dispatched automatically when
admitted, so `next` explains that wait without offering a manual `proof` action.

**RoleSelection** (`core/dispatch/routing.ts`). Eligibility gates, every profile that
meets demand, then rotation by weight times the cost lean, balanced by group.
Decides who may take a reviewer, coordinator or executor role. Enforces
[Profile selection](#profile-selection). Pures: `reviewerIndependence`,
`chooseProfile`, `taskRoutingPolicy`, `eligibilityReasons`,
`independentReviewRoutingConflict`. Resolution delegates to it. The file
imports no server module by value, because `store.ts` imports it.

### Observation and recovery owners

**Observation** (`core/recovery/observation.ts`). One sweep of unreleased runs: reads
each pending run's agent and settles, recovers, reminds or leaves it. Enforces
[Liveness and reminders](#liveness-and-reminders). Delegates remain on
Resolution for `observe` and `observationTargets`.

**Stalls** (`core/recovery/stall.ts`). Detects a stalled turn and reconciles an
operator-authorized stop of one against a fresh observation. Enforces
[Liveness and reminders](#liveness-and-reminders). Pures: `stalledStopDecision`,
`runningShellCommand`, `liveToolIssue`, `noTurnLive`. Delegates remain on
Resolution.

**ProviderRefusals** (`core/recovery/provider-refusal.ts`). Proves a reviewer's
provider refused its turn, then replaces the reviewer or records a finite
blocker. Enforces [Routine faults](#routine-faults). Pures: `refusalGap`,
`timelineDispatchState`, `detectReviewerProviderRefusal`. Delegates remain on
Resolution.

**CallbackReminders** (`core/intake/callback-reminders.ts`). Sends one bounded
reminder to a run that stopped without a result, then hands the fault to
attention when its grace expires. Enforces
[Liveness and reminders](#liveness-and-reminders). Pure: `reminderDecision`.
Delegates remain on Resolution.

**ValidationEvidence** (`core/qa/validation-evidence.ts`). Answers whether
validation is alive in a task's worktree, with one host scan per pass. Enforces
[Validation and proof](#validation-and-proof). Delegates remain on Resolution.

**TransientResume** (`core/recovery/transient-resume.ts`). Resumes a retained run or
the initial worker in the same thread after a transient provider error, and
arms rate-limit failover when the resumes run out. Enforces
[Retained worker recovery](#retained-worker-recovery). Pures:
`transientResumeDecision`, `transientSentDecision`, `transientWaitingDecision`.
Delegates remain on Resolution.

**RetryRoutes** (`core/recovery/retry-routes.ts`). Where a restart sends a parked task:
the continuation a replacement worker resumes, retry, worker resume, and the
stopped-revision restart. Enforces the restart arms in [Verbs](#verbs). Pures:
`retryRoute`, `resumeRoute`. Delegates remain on Resolution, including `retry`
so instance overrides still fire.

**AbsentRestarts** (`core/recovery/absent-restarts.ts`). Recreates proven-absent runs:
an absent worker in the retained workspace, an absent resolution run, an
uncertain-run restart under the same run ID, and the one-replacement creation
budget. Enforces [Orphan worktree after a timed-out create](#orphan-worktree-after-a-timed-out-create).
Delegates remain on Resolution.

**Recovery** (`core/recovery/recovery.ts`). The coordinator surface Resolution
constructs: it wires the stages together and keeps the method shape its callers
and tests use. Its stages are one module each. **CoordinatorRoute**
(`coordinator-route.ts`) decides whether a task needs a coordinator episode and
performs the one launch that opens it. **CoordinatorPass** (`coordinator-pass.ts`)
observes that exact run, settles it, and owns the pending-episode bound. Enforces
[Coordinator reports](#coordinator-reports),
[Coordinator loop breaker](#coordinator-loop-breaker) and
[Responsible tasks](#responsible-tasks-spec-058-cutover-1). **CoordinatorEpisode**
(`coordinator-episode.ts`) owns the episode's durable bookkeeping: the report
binding, the not-applied refusal, the run release, the settling changes and the
escalation. **Pseudo-checkpoint** (`pseudo-checkpoint.ts`) owns the post-budget
pseudo-checkpoint rule.

**RecoverySettlement** (`core/recovery/coordinator-settlement.ts`). Applies a
recovery report as the owner verb it names, once. Enforces
[Coordinator reports](#coordinator-reports). Its pure rules live beside the
report identity in `coordinator-report.ts`: `taskProgressDigest`,
`coordinatorReportMatches`, `coordinatorActionPlan` (report to verb arguments, or
the refusal naming why it no longer applies) and `recoverySettlementPatch` (what
settling the report changes). **Responsible fault settlement**
(`responsible-fault.ts`) is the Spec 058 mechanical fault code settles before an
episode opens. Delegates remain on Engine. RecoverySettlement is a separate class
because Recovery is built by Resolution without Engine, and the handlers stay
registered on Engine.

**Ladder** (`core/questions/ladder.ts`) and **blocker-ladder.ts**. A blocked worker gets
one reviewer consult per cause, then one planner escalation, which a planner or
decider settles or classifies to the operator. Also settles open escalations
when an ordinary control moves the task. Enforces
[Non-converging review ladder](#non-converging-review-ladder-spec-058-cutover-3)
and [Responsible tasks](#responsible-tasks-spec-058-cutover-1). Pures:
`blockerLadderStep`, `consultRecovery`, `escalationRecovery`, plus the question
and parse helpers in `blocker-ladder.ts`. `operatorQuestionStep` lives in
`operator-question.ts`. Delegates remain on Resolution; Engine keeps
`settleLadderControl`.

**Lifecycle** (`core/closeout/workspace-lifecycle.ts`). Workspace cleanup and post-merge
workspace recovery, including terminal archive source, archive retries, and
the consumer retention gate the engine calls. Enforces [Cleanup](#cleanup).
Engine constructs it.

**OriginRouting** (`core/questions/origin.ts`). Keeps the one task-owner field exact
and records a missing origin while delivery is still owed, with planner notice
routing and reparent authority for projects whose origin is unavailable.
Enforces [Owners and notices](#owners-and-notices). Resolution constructs it.

**Checkpoints** (`core/intake/checkpoint.ts`). Delivers each persisted worker
checkpoint continuation to the same retained worker, workspace and branch at
most twice (the original attempt plus one restart resume); the intent id is
the message identity, and an intent recorded by a revision run continues on
that run. Failed or uncertain provider delivery hands the fault to ordinary
attention. Enforces [Progress checkpoints](#progress-checkpoints).
Resolution constructs it. Reviewer checkpoints are a different path, owned by
ReviewContinuations.

**RunRelease** (`core/recovery/fence-settlement.ts`). Releases the runs no report will
settle: finished, observably idle, superseded or never launched. Enforces the
superseded-participant rule in [Invariants](#invariants). Delegates remain on
Engine.

**VerbFences** (`core/verbs/verb-fences.ts`). Displaces or refuses the runs an owner
verb would disturb. **ContinuationFences** in the same file holds Resolution's
different reviewer-continuation settlement. Enforces
[Durable effects](#durable-effects-and-unknown-delivery). Pure:
`classifyVerbRun`. Delegates remain on Engine and Resolution.
`DurableFenceRefusal` is the typed pre-send refusal.

### Question and notice owners

**Questions** (`core/questions/questions.ts`). Raised and delegated decisions, including
the shared in-flight maps. Enforces
[Delegated answers preserve the planner's conversation](#delegated-answers-preserve-the-planners-conversation)
and [Responsible tasks](#responsible-tasks-spec-058-cutover-1). The question
routers remain whole; dissolving them needs its own ordering tests.
Delegates remain on Resolution. Shared in-flight state lives on the
per-resolution Questions instance, exposed via getters on Resolution.

**NativeQuestions** (`core/questions/native-questions.ts`). Native task-thread
questions. Enforces the same delegated-answer rules. Pure:
`answeredQuestionOutcome`. Delegates remain on Resolution.

**Delegation** (`core/questions/delegation.ts`). Puts one question to one delegate under
an answer window, on the `delegation:<id>` stream, and finds the task and project
planner rungs, the decider profile and the task facts a delegate reads. `delegateQuestion`
in `planner-delegation.ts` walks those rungs in order and then the decider: a rung
observed gone is skipped, a live rung's silence opens the next, and an unknown send
stops the route. Enforces
[Delegated answers](#delegated-answers-preserve-the-planners-conversation).
Pures in `question-delegation.ts`: `binaryApprovalChoice`,
`delegateApprovedChoice`, `applyBinaryApproval`, `parseDelegatedAnswer`,
`nativeDelegationPrompt`. `delegateApprovedChoice` fail-closes operator-only
kinds (`scope`, `release`). Delegates remain on Resolution.

**AgentAsks** (`core/questions/agent-asks.ts`). Records, routes, waits on and resumes
`ask` (alias `nucleus_ask`). Holds the in-flight routing set and the in-turn wait and poll
cadence. Enforces [Delegated answers](#delegated-answers-preserve-the-planners-conversation).
`askBinding` is a free function in `core/questions/agent-ask.ts`. Delegates remain on
Resolution.

**AgentMessages** (`core/questions/agent-messages.ts`). Sends, delivers and sweeps
`tell` (alias `nucleus_message`). Holds the in-flight delivery set. Delegates remain on
Resolution. Every recipient is named by role, task, project or named agent and resolved
from the caller's run or participant ticket; a caller never supplies a thread ID.
Each recipient thread is observed before a send, and an archived or gone thread is never
sent to. A `tell` to a planner with no live thread waits in its project's inbox (a
queued record with `toProjectKey`) and is delivered by the sweep to the next live planner.
A named agent that is archived or gone refuses at send. An `ask` routed to an archived
rung moves on to the next rung.

**EffectReconcile** (`core/recovery/effect-reconcile.ts`). Settles an unknown send from
its exact message: reviewer deliveries, run creations and attention notices.
Enforces [Durable effects](#durable-effects-and-unknown-delivery). Pure:
`timelineMessage`. Delegates remain on Resolution.

**Notices** (`core/questions/notices.ts`). The one durable send every notice shares,
intent before the send and never resent blindly, and the attention, completion,
hold, lane-drain and decision delivery loops. Enforces
[Owners and notices](#owners-and-notices). Pure: `noticeSettlement` (skip,
supersede, re-point, keep uncertain, wait for a thread, or send). Delegates
remain on Resolution.

**TaskStops** (`core/recovery/task-stops.ts`). Writes a task's stops, incidents and
attention, and closes attention episodes and escalations. A true leaf.
Enforces the stop and attention writes the other owners call. Delegates remain
on Resolution, including `waiting` so instance overrides still fire.

**task-reasons.ts**. Reason text, refusal errors and small helpers the owners
share. A leaf: importing it never closes a cycle through `resolution.ts`.
Typed pre-send refusals it exports include `ProvenPreSendRefusalError` and
`RetainedRunRefusal`. **retained-work.ts** reads the retained author's
receipted results.

**Operations** (`core/planning/operations.ts`). Durable accept, run, settle;
submission intake; pre-dispatch repair (dispatch-base re-record, validation
retry). Holds the source-promotion, lead-check and re-key handlers. Enforces
[Durable effects](#durable-effects-and-unknown-delivery). Pure:
`operationFailureSettlement` (committed result, deferred validation, pre-send
receipt, state and effect status). Typed refusals settle failed with a receipt
whatever their prose says; unexplained failures use the prose classifier.
Delegates remain on Engine.

### Run-launch owners

**RunLaunchSource** (`core/dispatch/run-launch/source.ts`). The source a launch
dispatches from: detached ordinary-review custody and worktree, the first
revision worker's independent profile, the retained worker route, and the PR
head the run is launched at. Enforces [Profile selection](#profile-selection)
and [PR identity from reports](#pr-identity-from-reports). Pure:
`revisionRunPlan`. Delegates remain on Resolution.

**RunLaunchThread** (`core/dispatch/run-launch/thread.ts`). The thread a launch
dispatches on: the retained agent when it is still eligible, or a fresh one
from the pool, then the hand-off to reserve. Pures: `executorThreadDecision`,
`reviewerThreadDecision`. Delegates remain on Resolution.

**RunLaunchReserve** (`core/dispatch/run-launch/reserve.ts`). The intent row,
credential, slot charge, then the post-transaction hand-off to deliver.
Delegates remain on Resolution.

**RunLaunchDeliver** (`core/dispatch/run-launch/deliver.ts`). Ordinary-review custody
and checkout proofs, the guarded native send or creation, the agent binding,
and the uncertain or refused settlement when a step throws. The synchronous
prefix before the adapter call stays synchronous. Delegates remain on
Resolution. `ordinaryRoundCustody` belongs to `ReviewLifecycle`; its Resolution
delegate remains available to source and result-application callers.

`Resolution.launch` is still the funnel that sequences those four owners. The
funnel has not moved off Resolution.

### Control-flow strings

Code matches the words of an event kind, a reason, a refusal or an event
detail, and the class of an error decides how an operation settles. The pin is
`test/control-strings.test.ts`. Prefixes and reasons owners compare:

- `OWNER_STOP_HOLD_PREFIX` `'Owner stop:'` — Holds / OwnerStop
- `CAPACITY_WAIT_PREFIX` `'Waiting for a project slot…'` — defined in `shared/wait-state.ts`; SlotAdmission compares it
- `QA_CAPACITY_WAIT_PREFIX` `'Waiting for QA capacity (position '` — defined in `shared/wait-state.ts`; SlotAdmission compares it
- `RETAINED_WORKER_PROFILE_REASON` `'Retained worker profile is disabled or unavailable'` — defined in `shared/schema/state.ts`; readers Notices, Recovery, RetryRoutes, `task-reasons.ts`, RunLaunchSource
- `BACKPRESSURE_DEFERRAL` `'Paseo admission backpressure: '` — Admission (`core/host/admission.ts`)
- `EXTERNAL_MERGE_CHECK_REASON_PREFIX` `'External merge check:'` — ExternalMerge
- `EXTERNAL_MERGE_CHECK_RECOVERED_REASON` `'External merge check recovered; resuming task'` — ExternalMerge
- `ACCEPTED_PR_RECONCILIATION_REASON` `'Operator requested accepted-PR workspace reconciliation'` — Resolution.owns
- `ABSENT_WORKER_REASON` `'Agent creation is uncertain or placement differs; no replacement launched'` — CreationRecovery
- `PRE_AGENT_LAUNCH_FAILURE_REASON` `'Transient worker launch failed before an agent was created'` — CreationRecovery

Typed pre-send refusals that settle an operation failed with a receipt:
`ProvenPreSendRefusalError`, `ReviewEntryRefusal`, `ExternalMergeRefusal`,
`RestartRefusal`, `RepositoryRekeyRefused`, `RetainedRunRefusal`,
`DurableFenceRefusal`. `ParkedRestartPreSendRefusal` is the eighth class in
that set. Event-kind reads and writes stay in the census in
`test/control-strings.test.ts`; do not reword a kind.

### Confidence

Stated from the current owners and the topic sections they enforce. Less
confident, for a later pass:

- Lifecycle archive-retry and post-merge recovery internals beyond the cleanup
  contract, which I did not re-read in full.
- OriginRouting reparent edge cases beyond the owners-and-notices rules.
- Checkpoints worker-continuation delivery beyond the class contract and the
  progress-checkpoints section (reviewer checkpoints are ReviewContinuations).
- Recovery's remaining pass versus RecoverySettlement: the split is named, the
  leftover Recovery methods were not re-read one by one.
- `Resolution.launch` remaining gates versus the four run-launch owners: the
  funnel is still on the shell, and a later port should treat launch as one
  remaining funnel, not as four complete owners.
- Question routers still undissolved; the in-flight maps and ordering are
  current behaviour, not a finished split.

## Identity and authentication

### Submission and instruction source

- A submission pins its committed handoff identity and originating thread, and
  carries exactly one instruction source: a committed `handoffPath` or a `brief`
  held by Nucleus ([Spec 020](../specs/020-briefs-stored-in-queue.md)).
- Nucleus pins a brief by digest within 128 KB and writes nothing to the
  repository. Brief mode needs a v5 control manifest at the planning commit, or
  none; v1–v4 are refused because their hooks read committed handoffs.
- `planningCommit` stays required and pushed. In brief mode it must be an
  ancestor of the pushed base at submission, the current base at dispatch and
  the worker head at launch and continuation; handoff mode compares handoff
  bytes instead.
- Prompts carry the brief inline, labelled as Nucleus-held, and tell the worker
  not to commit it. Operator `amend_brief` (text and reason) pins a new version
  before merge and is refused after it; each run records the version it was
  given. A live worker or reviewer is told of the amendment as a message queued
  behind its current step (not an interrupt); an open `ask` is answered
  with the new brief. The next run is given the new version. `amend_brief` with
  no text re-pins a handoff and refuses brief tasks.
- Adoption requires a committed handoff and takes over an existing isolated
  worker without resetting files or inventing review approval; externally owned
  workspaces are preserved.
- The outcome row records the final brief version, its digest and earlier
  digests.
- Task rows stay slim (Tom, 2026-10-25): one stored copy of the brief text
  (`handoffText` is derived from it), lane-document pins by key, version and
  digest, and observation-only fields (last observed time, activity, status)
  never rewrite the task row or advance the board revision.

### Leads and promotion

- Brief-bearing leads ([Spec 026](../specs/026-planning-records.md)) keep every
  version exactly, with digests, authors and checks. Older versions are stored
  as reverse line deltas with a full snapshot every 32 versions; every read
  rebuilds the bytes and checks the digest, and a corrupt or missing delta
  refuses. No version is ever deleted.
- Only the latest passing version at its exact digest can be approved; an edit
  clears approval. Board approval records `operator (board)`; relayed agent
  approval needs an authorization note.
- Promotion rechecks planning, routing, dependencies and pre-dispatch policy,
  then one transaction admits the numbered task and links its source; a refusal
  admits nothing.
- A required worker/reviewer pair that shares a profile or normalized model is
  refused at check, promotion and every admission seam, before any task or
  workspace exists (Tom, 2026-10-12).
- Promotion is version-aware (Tom, 2026-10-19): each newly checked and approved
  version admits once per repository, and a retry resolves that version's
  original task or outcome. Spec 026 owns the version boundary.

### Lanes

- A lane ([Spec 019](../specs/019-lanes.md)) is an opt-in global grouping with
  key, title, aim, status (`active`, `paused`, `done`, `abandoned`), note and
  participating repositories. Lanes never gate dispatch and are never purged.
- A task belongs to zero or more lanes in order, keeping one identity,
  workspace and outcome. Attach with `queue.lane`/`queue.lanes` at submission
  or `set_lane` later (a full replacement list). One unknown, closed or
  non-listing key refuses the whole set; lanes are never auto-created.
- Prompts carry one title-and-aim block per lane as context, not authority. The
  outcome row records `lanes`.

### Task numbers

- Nucleus assigns a permanent per-repository number in the task-creation
  transaction ([Spec 021](../specs/021-task-numbers.md)); numbers are never
  reused. Reads carry `number` and `reference` (`repo#N`); worker PR titles
  start `N: title`. Task UUIDs and branch names are unchanged.

### Fetches

- Nucleus fetches serialize per canonical `--git-common-dir`. A fetch retries at
  most twice on Git's remote-ref compare-and-swap failure only; pushes, commits,
  submissions and promotions are never retried by this path. Planning identity
  and ancestry checks are re-read after the fetch.

### Runs and callbacks

Agents carry only `nucleus.*` identity labels, and discovery queries those and
deduplicates native agent IDs. A thread created before Nucleus is still read
through its recorded `northstar.*` labels wherever an archived or terminal
record is inspected, and a split identity is refused rather than guessed.
Callback environments carry only `NUCLEUS_*`; a ticket authenticates its run, and a helper refuses a report whose explicit task or run identity differs from that ticket. Worker readiness verifies the PR identity before recording a completion and refuses a foreign queue branch named in the report. A move to work clears an unbound result only when the forge positively identifies a different branch; unknown or unavailable evidence remains held, and the cleared event remains history.
Agents report only through their own run's binding; they never read or use another ticket under the data home. A refused report is reported as blocked through the same binding, not bypassed through another ticket or route; if that also refuses, the agent states the refusal. Retained agents keep their original callback binding. Historical events,
request identities and submitted handoffs are not rewritten.

- Completion authentication binds task and run. One worker creation mints
  exactly one run identity, shared by the task, the callback credential and the
  reporting binding; a path that could mint a second fails closed.
- A run whose live turn a verb cancelled is stopped, not replaced: its
  credential is revoked and a late callback is stale. Released or superseded
  runs stay immutable; late callbacks stay evidence without authority.
- Attention on a task with no live run owner lands in `needs_attention`, so a
  recovery control always applies.
- The queue-owned worker branch is fixed before launch. A `ready_for_review`
  callback requires worker release and a local worktree and open non-draft PR on
  that branch, targeting the recorded base, at the clean pushed worker head.
- A retained resolution run may correct its own authenticated `blocked` or
  `error` result to a successful role result before releasing its lease,
  through either the callback or the report bridge; both receipts stay durable.
- A lifecycle attempt's failure belongs to the run it observed or reserved.
  When a newer run has since been reserved, the failure is history
  (`superseded_attempt_failure`) and starts no deferral or recovery.
- Reuse a retained thread for a new run (revision, review continuation,
  restart) only when its report-binding file lives under the current data
  home. Rewriting the current-home ticket does not move the session's argv.
  A path outside that home starts the role on a fresh thread with the same
  profile and instruction, and records why. The check is the binding path,
  not a special case for a data-home move. `restart` follows the same rule.
- A report refused because the binding names another run, through a ticket
  outside the current data home, does not tell the agent to retry that
  callback. The reminder is skipped; the next restart or dispatch relaunches
  the role on a fresh thread.

### Owners and notices

- A task has one owner, `notificationAgentId`, recorded at submission
  ([Spec 040](../specs/040-merge-hold-release-prompts.md), Tom, 2026-10-26).
  `queue.reparent` changes it for listed open tasks or every open task of a
  project; the caller is the operator, the current owner, or that project's
  registered planner (falling back to the Nucleus planner). The new owner must be
  a live planning thread. History, settled notices, frozen cohorts and
  third-party holds are never rewritten.
- A missing, archived, or non-thread origin remains recorded in `originError`.
  When the project or Nucleus has a planner, the task keeps running, origin notices
  go to that planner, and the planner may reparent it. A submitted non-thread
  origin is accepted as absent and resolved by the origin-routing pass; this
  keeps external submitters from assigning notices to a label that is not a
  Paseo thread. Without a planner fallback, the existing visible stop remains.
- The operator (`operator`, `operator (board)`) is not a thread. An
  operator-origin task has no origin thread, workspace or planner of its own;
  its notices go to an explicit notification thread, else the project's
  planner, else the Nucleus planner (the project that holds origin
  `inflatable-cookie/paseo-northstar-queue`), else stay pending
  and visible.
- A task's own planning questions — delegated agent asks, blockers, proof waits
  and board-question notices — reach its task planner first: the thread a brief
  named, else its owner. The project planner is the fallback rung (task 1109).
- Project-level notices that once followed the Spec 042 owner — origin
  fallbacks, proof-wait attention, scheduled-milestone-QA reminders and the
  drain prompts — follow the project's planner (`project.set-planner`) and then
  the Nucleus planner. A project with no planner and no live owner record is
  dormant: silent, with no drain episodes.
- Completion notification uses an explicit per-task cohort, empty by default:
  `notifyOriginOnCloseout`, creator-nominated agents and live self-subscribers.
  The cohort freezes at `done` with one fenced notice per recipient; membership
  grants no authority and does not hold cleanup.
- A finished task that owes its origin no notice clears any earlier
  missing-origin error and its stop.
- Every notice to a planning thread waits until the thread's turn ends (Tom,
  2026-10-04).

## Dispatch and workspace

### Admission, limits and priority

- Submissions run required read-only `task.pre_dispatch` policy against an
  ephemeral task before insertion; a refusal returns synchronously with no task,
  incident or workspace intent. Dispatch rechecks the pinned policy before its
  external effects.
- A review-skipping submission is refused when the repository's pinned manifest
  binds closeout to a required integration-write `task.closeout` hook (it needs
  a review identity that lane never produces), or when the repository has opted
  into formal PR reviews.
- Dependencies must finish including closeout; only `done` satisfies
  dependants.
- The board's pause control is an icon-only button the same size as the header
  icons beside it, with a chevron attached that opens a menu of Pause or Resume,
  Dispatch hold or Release dispatch hold, and Stop (Tom, 2026-11-05). Selecting a
  row performs that action immediately and closes the menu. The pause menu shows
  how many runs are still bound and a `drained` flag; nothing new is added to the
  header. Stop pauses, then stops active threads through `queue.stop-threads`.
  Pause and dispatch hold have separate one-click release controls and may both
  be on; pause wins.
- Board dispatch hold is an operator-only persisted setting beside pause, read
  through `snapshot` and `next`. It blocks never-started queued tasks before
  workspace or worker creation, with “Dispatch held by the operator”. Recorded
  launch intent counts as started so reconciliation can settle it. Started work,
  revisions, reviews, verification, merge, closeout and recovery keep running.
  Owner verbs and task-specific holds keep their existing meaning. Releasing the
  board hold clears no task hold and uses the existing dispatch order and capacity
  gates. Each dispatch pass reads this setting once, with no additional task scan.
  Scheduled and manual project QA are unaffected: QA has its own fence.
- A new store starts paused with an empty worker pool, so nothing dispatches
  until the operator adds profiles and resumes. Pause survives restarts.
- Pause stores submissions and defers new dispatch; existing work drains (Tom,
  2026-11-05 and 2026-11-08). Under pause, no new run of any kind
  starts (dispatch, revision, reviewer, coordinator, recovery, proof, or a
  continuation that opens a run). Workspace creation and accepted-PR workspace
  recovery do not start; binding a workspace that already exists still does.
  In-flight work settles: callbacks, stored results including closeout, finished-thread
  release, operations and reconciliation. Recorded hook intents settle; retired-errored
  agent archive waits for unpause and does not hold `drained`. Recovery escalate
  and origin messages stay stored, so those runs stay bound (`drained` stays false)
  until unpause applies them. `service.health` and the pause menu report bound runs and `drained`
  (true when no run is unreleased and no operation is in flight). A constructing
  service reports `drained` false. Dispatch hold stays a separate control. Stop
  (`queue.stop-threads`) stays separate. Who may set pause is the existing
  `queue.control` authority.
- Slots count live agents (Tom, 2026-11-03): default 32 globally (max 64)
  and 5 per project (1–32). A task holds a slot only while one of its agents
  is live or starting — a worker, revision, reviewer, executor, recovery or
  closeout coordinator turn (an unreleased run with a live or starting agent,
  or dispatch creating its workspace ahead of the launch). A task with no
  running agent that is only waiting on hosted checks, the repository
  integration (merge) turn, mechanical verification, a thread release or
  settlement holds no slot; it keeps its merge order, and when it next needs
  an agent it requests a slot through the ordinary fair-share order. `done`
  and `cancelled` tasks never occupy one, even while a run lease remains
  unreleased. A terminal task's unreleased run intent with no agent is
  abandoned on sweep with a recorded reason; launched runs keep the normal
  settlement rules. The merge order lives in the integration turn and its
  lease, not in slots; workspace creation pacing and the Paseo-call bound keep
  their own gates.
- A dispatch hold prevents new task-work launches, but does not itself occupy a
  slot. A parked dispatch-held task with no live agent is not an occupant;
  a live or starting agent keeps its slot while dispatch is held.
- Capacity waits and the board's slot counts report agents in use: the occupied
  count names the live-agent occupants, and the wait names in-flight tasks
  that hold no slot (checks, merge turn, thread release) separately, so the
  blocking work and the waiting work are each visible to planners.
- Parked `awaiting_review`, `changes_requested` and recovering
  `needs_attention` requests rank ahead of never-dispatched requests. Within a
  tier, `queuePriority` orders globally and equal priorities keep round-robin
  project fair share.
- A queued task waiting on a prerequisite does not block a runnable task behind
  it in the same project. When the prerequisite settles, its dependent resumes
  its existing place in dispatch order; queue indexing must preserve that order.
- Dispatch reads indexed ready heads, not every queued row. Prerequisite settlement
  wakes its dependants after commit and refreshes their checkout siblings when the
  final prerequisite settles, even if dispatch is held. Refresh work grows with the
  affected dependants; their dispatch wake is coalesced per repository. A missed
  refresh is also checked before dispatch. Route-unavailable requests are reconsidered
  when the effective routing inputs change. Queued prerequisite, hold and capacity
  text is derived on read; waiting alone does not write a task or event.
- The board carries up to five queued heads per repository and the total queued
  count. `queue.queued-page` reads the rest on demand. A completed mutation that
  advances the board revision publishes before its reply; the timer budget applies
  to periodic and unchanged publications.
- The 20-second safety sweep handles active work and queued lifecycle obligations;
  it does not visit ordinary queued tasks. Its maintenance preflight still checks
  retained terminal and exceptional queued records, so its cost grows with those
  records; it is not a queue-position refresh. Origin routing observes each queued
  owner once and visits its tasks when the recorded workspace or origin changes.
- `promote` gives a queued or parked unmerged task priority above every live
  task until completion or cancellation, and skips the workspace-creation load
  guard (`load_guard_skipped`).
- An accepted `restart role=worker` returns a retained pre-PR task to the normal
  `changes_requested` slot request; full capacity leaves it waiting without
  spending recovery budget. It never bypasses slot limits.
- Per-project overrides (Tom, 2026-10-04) replace the project default within
  the global cap; 0 admits nothing new and leaves running work alone. Overrides
  are operator settings, set from Settings → Dispatch limits.
- First dispatches that create Nucleus-owned workspaces also obey a per-project
  in-flight task cap (Spec 058, Tom, 2026-11-04). The cap is always twice the
  effective project slot limit and follows changes to that limit; it has no
  override of its own (Tom, 2026-11-08). Count every
  nonterminal task with a Nucleus-owned workspace or workspace-creation intent.
  Parked faults and explicit holds without a live agent do not reserve first-
  dispatch admission; their workspaces remain retained. Mechanical verification
  waits do not reserve agent slots. Adopted workspaces and
  review-entry tasks preserving an external workspace do not count; proof-only
  tasks count when Nucleus owns their workspace. Intake-owned review-entry
  workspaces count once bound, but their first admission creates no workspace
  and therefore does not enter this creation gate. Only the first queued
  dispatch that creates a Nucleus workspace waits at the cap, with a visible
  `Waiting: N of M tasks in flight for this project` reason and no slot
  reservation. Reviewer, revision, executor, recovery, merge and closeout turns
  on existing tasks are never gated, even above the cap. The header summary's
  slot count opens a popover listing per-project slot occupancy and in-flight
  count against cap for projects with at least one slot occupied, most-used
  first; existing slot counting and fair-share order are unchanged.
- Papercut tasks have a separate per-project allowance, `papercutProjectLimit`
  (default 2, 1–32; Tom, 2026-10-07), shared by a project's repositories. They
  occupy global slots but not ordinary project slots. Promotion pins the
  papercut class.
- Host-wide limits and timers are operator settings; who may write them is the
  [service boundary](service-boundary.md)'s rule. Lowering a limit never stops
  active work.
- A wait reason reports actual occupancy and the reservations ahead of it, never
  a full cap that isn't full.

### Profile selection

- Nucleus keeps its own profile list ([Spec 052](../specs/052-usage-level.md),
  Tom, 2026-11-06/07): durable records with id, name, provider, model, mode,
  thinking level, feature values and notes, all in one canonical vocabulary
  (`shared/profile-vocabulary.ts`, task 1158). `profile.list`, `profile.create`,
  `profile.update`, `profile.remove`, `profile.vocabulary`,
  `profile.compatibility` and `host.catalog` are the surface
  (`shared/profiles.ts`, `shared/host.ts`, `core/planning/profile-import.ts`). Each host
  reports its own catalog in its own spelling, and its adapter owns one
  translation table from the canonical vocabulary (`hosts/<host>/vocabulary.ts`);
  nothing is mapped per profile. Each host's routing snapshot carries the values
  its table translates to (the host's own provider key included), and a value a
  table can't express makes the profile unavailable there with the reason. A
  task's `routingPolicy` (on `queue.detail` and `next`, both read against the
  task host's snapshot) lists the enabled pool profiles its host rules out or
  translates (`host.effects`) and how automatic worker
  selection reads now (`selection`: complexity, role and usage offsets, the
  first-attempt step, the demand, the profiles meeting it ordered by recent use
  over effective weight, and why the leader wins). An earlier migration
  copied the host's profile list once with ids unchanged without overwriting
  a Nucleus profile; routing does not re-import it. A stored profile's availability is read against one host's
  catalog and a missing provider or model is a refusal, never a fallback to
  another model. Settings → Profiles (`client/settings-screen.tsx`) creates and
  edits a record from what the host reports for the chosen model, and shows each
  record's availability and plain reason on this host, reading the host catalog
  Nucleus stored and replacing it on Refresh (the
  [service boundary](service-boundary.md) owns that rule). Selection and
  dispatch use the stored list with availability from the live host catalog.
- Enabled flag, provider and group availability and thinking support are the
  eligibility gates; every profile can work, review and coordinate
  ([Spec 053](../specs/053-demand-based-selection.md), Tom, 2026-10-21).
- Demand is the task's `complexity` (required on new submissions; `medium` when
  absent), moved by the role offset and the usage level. Selection keeps every
  eligible profile whose `capability` meets demand, else the most capable
  eligible profiles, then rotates over the last 50 assignments by recent use
  over effective weight: configured weight times a cost lean that doubles per
  cost step down (Spec 053, Tom, 2026-11-04: cost leans, it doesn't exclude).
- Frontier profiles, and profiles above the usage level's cost ceiling, need a
  per-role request with a reason and the operator's board sign-off unless the
  usage level puts them in automatic selection: frontier only at Maximum
  ([Spec 052](../specs/052-usage-level.md), Tom 2026-11-09). Worker authorization does
  not authorize frontier review or coordination.
- For Nucleus's own implementation and review work, request frontier profiles
  while usage allows, per role with a reason (Tom, 2026-10-18).
- A coordinator's `route` never names a very_high-cost (Sol-class) profile;
  availability and environment blocks are not capability failures (Tom,
  2026-10-01 and 2026-10-15). Owners may route there with a reason and board
  sign-off. A coordinator never routes to a frontier profile below Maximum either.
- Before every retained revision Nucleus rechecks the worker profile against the
  live catalog, role, enablement and subscription group; failure stops in
  `needs_attention` before run intent and escalates without a coordinator turn.

### Holds

- `hold`, `release` and `keep_hold` take `kind: dispatch|merge` and apply to
  queued and dispatched unmerged tasks
  ([Spec 040](../specs/040-merge-hold-release-prompts.md)). The fences are
  independent, each with owner, reason, generation and optional `until`.
- A dispatch hold blocks dispatch and fences fresh worker, reviewer and recovery
  runs; existing runs' results are still applied.
- While merge-held, review and every other step proceed, but
  Nucleus claims no integration turn and records no merge intent, and the held
  task never blocks later tasks. The merge request is the boundary both fences
  stand at (Queue #531): a dispatch hold still lets review, verification and the
  merge gate's reads proceed, but a held task records no merge intent and claims
  no integration turn, so an owner stop on a task past review never merges it.
  A merge already requested is reconciled, never cancelled. A hold is refused
  once merge intent exists.
- `queue.mergeHold: true` (with `queue.mergeHoldReason`) on a brief starts a
  merge-only hold at submission. `lead.promote-task` and
  `papercut.promote-task` accept `hold` to create the task dispatch-held.
- When the merge hold is the last blocker, Nucleus prompts the owner once per hold
  generation and head, reminds every `holdReminderMinutes` (120) and escalates
  to the Decisions view after `holdEscalationMinutes` (240).
- `until` names a task or time ([Spec 046](../specs/046-self-lifting-merge-holds.md));
  a met condition releases that fence (`hold_auto_released`); an impossible
  target keeps the hold and prompts the owner.
- Presentation: the dispatch fence is the wait on an unstarted task and the
  merge fence on one ready to merge; the card shows that fence's live reason,
  owner and age. Stored fields are never rewritten by this derivation.
- A hold enforces a pre-merge gate Nucleus cannot see; it grants no new
  authority. A hold may use an older task version when only observation fields
  changed in between.

### Wait states and prerequisites

- Waiting work carries one derived wait state with an owner and clearing action:
  `waiting_capacity`, `waiting_prerequisite`, `needs_operator_input`,
  `needs_source_rights` and `merge_hold`. Before merge intent the dispatch
  cause is the primary wait. Derivation changes no scheduling decision
  ([Spec 043](../specs/retired/043-declared-review-stages.md) (a) owns
  precedence).
- A dependent's prerequisite wait is derived on read. After the final prerequisite
  settles, its checkout siblings refresh even if dispatch is held; a pause defers
  that work until unpause ([Spec 028](../specs/028-fresh-sibling-checkouts.md)).
- Declared-stage execution is retired (Tom, 2026-10-06): a submission declaring
  `queue.stages` refuses, and stage records stay readable history that never
  dispatches or merges.

### Host outage

- A task's host is part of its identity (Tom, 2026-11-14; T3 lane document v18,
  host dropout option 1: wait). While its host is unavailable — the service
  health `state` is not `online`, so the transport is not connected — the task
  records its own durable wait (`resolution.hostWait`: the host and the time the
  outage was first observed). The outage record is durable (`hostOutages` meta),
  so a service restart during the outage keeps the same start.
- The wait is independent of the task's stop (nucleus#1198 review). When nothing
  more specific already stops the task the stop reads `host_unavailable`, naming
  the host and the outage start. A stop that belongs to an owner answer (budget,
  ladder escalation, responsible question, hold, proof wait, interactive turn,
  paused stop, operator attention) keeps its own record and question: the host
  wait still pauses the wall clock, shows on the card beside the stop, and joins
  the project's outage notice.
- Nothing is sent to that host: no quantum, launch, continuation, notification,
  recovery or coordinator, and no stall, incident or escalation is raised from
  the outage. The wall-time budget pauses for the wait (Spec 058 budgets). New
  dispatch for a project whose host is away waits the same way.
- When the host returns, the wait clears and observation re-proves each retained
  thread before anything is sent; the task continues on the same host and
  threads. Delivery that was unknown stays unknown — an outage is never a reason
  to replay it.
- Moving a task to another host stays an explicit owner decision: there is no
  automatic failover and no `move host` verb.
- Past the dispatch-limits bound (`hostOutageNoticeMinutes`, 120 by default) each
  affected project's planner receives one notice naming the host, its outage
  start and the tasks held on it, through the ordinary durable notice path.
  Tracking is per project on the outage, so a project that becomes affected
  later, or whose planner is only resolvable later, still hears once for the
  same outage; a project that already heard never hears again. The notice is
  about a live outage: when the host recovers before its planner can take it,
  the pending notice is superseded with "outage ended before delivery" and is
  not sent, and its stored text is never rewritten at delivery (planner ruling,
  2026-11-14). An interrupted send keeps its durable intent: it settles as
  `uncertain` before the ended-outage rule applies, so an outage ending first
  never relabels unknown delivery as not sent. A shorter outage tells nobody,
  and a fresh outage starts unnotified.
- The board card of a waiting task shows the same wait ("Waiting on <host>
  since …"); host health itself is unchanged.

### Orphan worktree after a timed-out create

- Initial workspace creation is Nucleus-owned bulk Git: `git worktree add` into
  `<work-root>/queue/workspaces/<digest of git common dir>/ns-<taskId>`
  under the 600 s bulk ceiling, then registration with Paseo as a directory
  under the active project rooted at the repository. Populate stays outside
  Paseo admission and is not timed as Paseo latency.
- The external placement admits creation only while the path’s volume and
  canonical root are proved. An absent or unprovable configured volume holds new
  creates before assignment is charged; the same identity must be proved again
  before work resumes. Retained workspaces on the configured volume wait while it is unprovable. Paths outside the active placement remain history and are never probed. A positively different volume identity or
  redirected checkout path is refused for attention, not treated as a drop.
  Legacy recorded paths stay owned in place.
- Durable `workspaceIntent` is recorded before populate, with start and finish
  events. A timeout is a partial leftover, never absence or permission to
  replay.
- Reconciliation inventories the Paseo listing, `git worktree list`, the owned
  path, the task branch and a live `git worktree add` scan before bind or retry:
  found-done binds once. A settled, ownerless initial create proven absent or
  base-identical and unpublished is removed if needed and replayed once by the
  sweep, with its attempt recorded before removal. A crash or uncertain removal
  does not authorize another automatic attempt. Running or unreadable work is
  not replayed; authored, published, foreign-locked or conflicting leftovers
  remain with their owner.
- `retry_effect workspace_creation` with `discard` removes an unpublished,
  base-identical, Nucleus-owned or locked-`initializing` leftover (and its branch
  at the inspected head) and replays the same create (`orphan_workspace_removed`).
  Without the flag nothing is removed.
- If removal is interrupted after the worktree goes, the base-identical
  unpublished branch alone is removed the same way, so a replay never mints a
  suffixed branch.
- Ownership follows the real bound workspace, canonical repository and exact
  Nucleus-owned path, never a slug, project name, status or directory existence.
- Creation first looks for a canonical workspace and returns it or refuses
  ambiguity before calling Paseo.
- Under host pressure, new workspace creation admits one start per admission gap.
  An open creation intent holds only its own task: "a stuck task shouldn't block
  the board" (Tom, 2026-11-06). The gap follows one-minute load: none at
  or below CPU count, 20 s up to twice CPU count, 60 s above that. Operator ruling,
  Tom, 2026-11-05, to "Are you happy to let more tasks start while load is high?":
  "Yeah go for it". The next admission time is durable (Tom, 2026-10-07), and it
  arms one dispatch wake at its end, so a paced task starts without waiting for a
  sweep. The wait text names the gap, not a time. Pause, holds, dependencies,
  limits and degraded Paseo admission still bind.

### Sibling links and preparation

- A directory workspace skips the repository's `paseo.json` `worktree.setup`.
  Nucleus places only the sibling links declared by `nucleus worktree prepare`
  beside the checkout (Tom, 2026-10-23, links only). Unsupported setup
  declarations produce findings and their links are not placed; Nucleus runs no
  hook, install, build, container attach or backfill.
- Eligibility is recorded with the dispatch intent that creates a checkout
  (`worktreeLinks: eligible`); its binding moves it to `pending`, and only the
  first worker launch of that binding provisions. The final `prepared` record is
  written once and never re-armed; failures and conflicts are non-blocking
  findings. A record that cannot be written stays `pending` and the prompt says
  links may be missing.
- Links resolve through configured primary checkouts, live and unpinned, are
  shared by the repository's tasks and are never removed by Nucleus. The worker
  prompt, task detail and `next` disclose the record.
- Manual preparation stays per brief: a brief may authorise exactly one `effigy
  bundle sync --json` and one read-only `effigy bundle inspect --json` in the
  checkout, naming the installed tool. A missing or unreadable result is a
  blocker, never permission to sync again. A repository whose setup installs
  dependencies needs that preparation named separately. Automatic preparation is
  an [open question](../questions.md#should-queue-prepare-declared-bundles-in-task-checkouts).
- At worker creation and prerequisite release, Nucleus fast-forwards clean
  detached checkouts beside the task worktree to origin's default branch and
  records dirty, branched or diverged ones as findings; failure never blocks
  dispatch ([Spec 028](../specs/028-fresh-sibling-checkouts.md)).

### Parked dispatch and workspace repair

- Owner `restart` may return a settled pre-dispatch task to `queued` when its
  visible workspace matches the recorded ID and directory and passes the
  dispatch proof. Dispatch reuses the recorded workspace and never issues
  another creation for it.
- Owner `restart` with `rebindWorkspaceId` repairs a pre-worker record only
  after verifying a unique visible target on the canonical branch; no content is
  discarded. Durable displacement evidence allows later cleanup of that exact
  collision branch.
- Owner `retry_effect` archives a recorded duplicate (an unconfirmed archive
  intent or a rebind-displaced workspace), never the current workspace, and only
  when it is clean, on the Nucleus branch, with no commits beyond the planning
  base and no other task reference.

### Environment

- Nucleus never runs `git stash`; every worktree-facing prompt forbids it. Nucleus
  records the stash list at worker and revision creation, and a dirty-worktree
  check names entries popped, dropped or created across branches during the run.
- Installed: every local agent Nucleus creates gets the standard per-user
  `CARGO_HOME` and `CARGO_INCREMENTAL=0` (Tom, 2026-10-15); task build outputs
  stay checkout-local. Approved, not yet built: Cargo environment injection
  leaves Nucleus for repository teardown, Effigy or the Paseo profile (R8,
  [vision](../vision.md#simplification-rulings-2026-10-31)).
- Installed: every run turn Nucleus sends, whether a new launch or a continuation
  of a retained agent, gets its own `TMPDIR`, `TMP` and `TEMP`, named by an
  8-hex digest of its run identity under its repository's short root
  `<work-root>/scratch/<namespace>/` and created owner-only before the prompt
  is sent. A continuation re-proves its recorded path and recreates a missing
  leaf on its recorded proved volume. Recorded scratch leaves off the checkout volume are forgotten without probing anything. `scratchNamespace` is an optional repository
  setting; absent an override, Nucleus uses the repository name. Compatibility aliases
  belong in the repository’s `scratchNamespace` setting, never in source. Short run roots and hash-named test socket fixture directories
  keep Unix socket paths within macOS's 104-byte limit, including the longest
  repository namespace. Earlier `q/<12-hex>` and `runs/<runId>` roots remain
  readable for already recorded runs.
  The task row or resolution-run row records the exact temp root before launch.
  Nucleus removes only a recorded direct child after re-proving the mounted
  volume and checking it is a real directory; symlinked or foreign paths are
  logged and left in place. A released run keeps its leaf while its thread can
  still take another turn, because that thread's long-lived tool processes
  started with its environment. Removal happens when the thread is archived or
  its task is terminal or removed, and takes every recorded leaf that thread
  started with through the same recorded-leaf path; a run that releases after
  its thread is already archived removes its leaf at release. Terminal cleanup
  removes every leaf the task recorded, on either volume.
  Prompts name the current run's directory, direct agents to prefix commands
  with that directory in `TMPDIR`, `TMP` and `TEMP` (including retained agents
  whose launch environment is older), direct agents to put fixtures in a child
  `mktemp` directory, and forbid deleting the owned root or its parent. A shell
  command prefix and a tool process in one thread therefore agree on what
  survives the run: every leaf that thread was launched with lives until the
  thread retires. Two runs therefore never share a test runner's temporary
  IPC socket, and one run's leftovers are never another run's environment fault.
  The directory is created only after the mounted volume proves its own identity
  — the expected volume UUID, external and writable — and every existing
  component down to the scratch root is canonical on that device, so an absent,
  redirected or boot-disk mount refuses the launch instead of creating the tree
  on the internal disk. It never falls back to the daemon's own `TMPDIR`.
  A milestone QA run uses the same placement: each new run gets a leaf under its
  repository namespace, stages see it as `TMPDIR`, `TMP` and `TEMP`, and Nucleus
  removes the leaf when the run settles and its checkout is cleaned up. A QA run
  already in flight keeps the environment it launched with; an absent volume waits
  or refuses as other admission does and never falls back to the service process's
  `TMPDIR`.
- Shared Rust build and cache policy belongs to Project-c (Tom, 2026-10-09); no
  reusable compiler-cache manager is built in Nucleus, and no shared
  `CARGO_TARGET_DIR` is introduced.

## Worker run

### Prompts and instructions

- Worker prompts separate action from status. Revision and resume requests
  store their text as `pendingWorkerInstruction`; dispatch copies it onto
  immutable `run.instruction` and clears it. `task.reason` stays status.
- A blocked/error retry with no pending instruction derives a neutral
  continuation from the approved instruction source and carries the latest
  authenticated blocked result as diagnostic context, which grants no
  permission.
- A continuation without review findings is never told a defect exists (Tom,
  2026-10-23): findings and review references render only for a recorded review
  summary with text. A restart's reason stays audit text, never instruction.
- `move to=work` may carry one operator-approved `instruction` for an open
  unmerged PR; it binds to exactly one revision run beside the handoff and
  findings and is never replayed. Without one, the worker gets the pending
  instruction or the review findings.
- Lane, sibling, link and cleanup disclosures in prompts are context, not
  authority.

### Validation and proof

- Worker, revision and reviewer prompts carry the task validation rule (Tom,
  2026-10-07): run once, through Effigy selectors, every check covering the
  change (touched-code tests and QA groups, a compile, docs checks if docs
  changed, any brief-named proof). The repository's `AGENTS.md` Validate section
  selects them; it is the only source (Tom, 2026-11-09, task 985): the
  per-repository validation policy setting and its Nucleus-wide default are
  retired, and prompts carry one fixed line naming the section and milestone QA
  on main via `project.qa.run`.
- The affected-test run (Tom, 2026-11-12, nucleus#1164) is the one standing
  test run before review: the worker runs `effigy test:affected --run` at the
  committed head after its commit, and the reviewer judges the reported command
  and file count there. A missing or failing affected run is a review finding;
  anything wider than the affected set never is. The worker, revision and
  reviewer prompts carry `AFFECTED_RUN_RULE` and `AFFECTED_RUN_REVIEWER_NOTE`.
- Skip full `effigy qa`/`ci` and repeat passes; raw `npx`/`cargo`/`bun`
  validation has no exception. Formatting applies only to changed formatted
  source with a covering Effigy format selector; a missing selector is a
  papercut, not a review blocker. The TypeScript formatter applies only
  formatter hunks overlapping changed lines, reports other formatting drift,
  and exits successfully when it has formatted the changed hunks. Full
  milestone QA is `project.qa.run` on main.
- Counts requiring a live Nucleus store read are planner evidence. Reviewers
  judge the worker's recorded counts and list any live-store verification as a
  planner follow-up, never as an awaiting proof.
- Missing required proof blocks approval. The covering checks never waive a
  proof the brief names, so the rule is fixed prompt text no repository content
  can edit.
- The required-proof instruction ([Spec 054](../specs/054-required-proof-admission.md),
  Tom, 2026-10-24) renders outside the validation block in worker, revision and
  reviewer prompts, so the two rules cannot be edited against each other. It
  refuses nothing itself.
  Spec 058 cutover 2 (2026-11-02) retired the brief verdict and pass-gate keys:
  a brief states the outcome and acceptance in prose and the retained reviewer
  judges a named proof; `queue.mergeHold` keeps an owner-gated proof off the
  merge gate, and the retired keys are refused at intake with the replacement
  named.
- Acceptance-proof actor rule (2026-10-27): a proof the brief assigns to the
  reviewer is performed by the reviewer; one the brief assigns to a separately
  owner-activated executor (Spec 055) is judged from its evidence and never
  re-run; any other proof stays the author's, and a missing one is
  `changes_required`. Nothing is assigned to an executor by default.
- A corrective rerun may verify a corrected final head after a required
  typecheck fails on implementation errors, reporting both results; this grants
  no repeated green checks, full QA or Cargo builds (2026-10-06).
- Worker prompts require tests to use the runner's timeout and forced-exit
  options.

### Source-immutable proof executor ruling

- A manual or external source author without a supported heavy execution route
  can get one Nucleus-created proof-only run on the same task (Tom, 2026-10-24;
  [Spec 055](../specs/055-source-immutable-proof-executor.md)). The brief names
  one `queue.proofExecution` selector and input hashes; the operator at the
  board, or a relayed operator note, activates it with the `proof` verb
  (Spec 058 cutover 5: the retired project-owner authority is gone).
- The `executor` run goes through ordinary launch, admission, lease and callback
  paths, observes the checkout at the exact published head with no source
  writes, runs only the named selector and reports separately from the source
  author. It publishes no review and reaches no merge. Its allowance is one per
  distinct exact head; a new head requires an authenticated author revision and
  retained-reviewer source approval there, and earlier executions stay recorded.
- A proof-only task provisions its detached checkout at `queue.proofOnly.commit`
  even when that commit is an ancestor of the selected base tip. Before executor
  launch, initial dispatch, owner restart, recovery and workspace reuse resolve
  the checkout through the same target helper (`taskCheckoutTarget`) and
  recheck the checkout; a clean owned checkout at another
  commit is detached to the required commit, while a dirty checkout is refused
  without resetting it. When the project checkout has `node_modules`, the proof
  checkout reuses it through a symlink before executor launch. The proof commit
  must remain an ancestor of the base.
- A proof-only settled receipt with no closeout verdict is reviewed again through
  `move to=review` or `route role=reviewer` at the same commit: the receipt is the
  subject, no PR is needed, and no executor or allowance is spent again.
  `next` marks `proof` unavailable once that allowance is spent. A proof-only
  escalation never offers a worker return; it offers the receipt review instead
  ([Spec 055](../specs/055-source-immutable-proof-executor.md)).
- A dispatch hold or pause refuses activation; a merge hold is untouched;
  feature delivery activates nothing. A passing claim re-proves the source, and
  later reviewer independence accounts for the executor's models. A distinct
  independent reviewer still performs its own proof.
- An executor dispatch is proof execution, never a worker or review retry
  (nucleus#1195): the automatic Spec 058 start and the owner `proof` activation
  are never classified as `recovery_rerun`, so `noAutomaticRetry` neither fences
  nor escalates them and no recovery episode opens while an executor run is
  unreleased. An owner stop — "Stop and keep the work" included — applies its
  dispatch hold and leaves a live executor's turn alone until it reports or ends.
  An unreleased executor with an idle agent and no recorded result is offered
  `restart role=executor`, which asks the same executor on its same run and
  credential to resend its report only, and `tell role=executor` reaches that
  thread; neither re-runs the selector nor spends another allowance.

### Progress checkpoints

Author reports distinguish an observed blocker from unfinished work. Task size, an estimated turn budget or self-assessed context pressure alone do not establish an execution failure or external impediment. A blocked or error report names its concrete failure in `impediment`; one with no impediment and no new commit continues in the same thread, up to twice, before the blocker ladder (Spec 058 Slice 20). Positive Git evidence decides unfinished work: a responsible worker or revision return that pushed commits past its run's starting head is an unfinished continuation with no recorded external cause, whatever words its summary used, and it continues the same round. Use bounded source reads and runtime compaction where available; a provider or runtime limit that actually prevents progress remains reportable with its observed error. A final usage snapshot neither proves the peak nor establishes why a turn ended. Nucleus does not promise a fresh session after a blocked report. A deliberate handover of real committed progress uses the existing checkpoint path only where that run permits it and within its allowance. This guidance does not reject genuine blocked reports or change callback, checkpoint or recovery admission.

- An authenticated `progress_checkpoint` is a bounded deliberate stop for the
  task worker before a PR is accepted, and for the task's current revision run
  on a retained PR
  ([Spec 008](../specs/008-bounded-worker-checkpoint-continuation.md)). It needs
  current identities, a clean worktree and any new head pushed.
- An accepted checkpoint releases the turn, increments the task's ordinal and
  persists one continuation intent before asking Paseo to continue the same
  worker; the ordinal and intent are the restart and duplicate authority. At
  most three per task, shared by the initial worker and every revision run, so a
  long revision cannot mint a second allowance; the fourth enters attention. A
  revision continuation is delivered to that revision run with its own run
  identity and credential.
- The continuation carries only the summary, the original instruction and the
  retained identities. A pre-PR `incomplete` blocked/error report after the
  budget is spent resumes at most once, then escalates.

A rejected checkpoint after PR acceptance is not accepted progress history. When
an author reports a genuine blocked or error result, the owner can use the
ordinary restart or move-to-work route to continue unfinished retained PR work.
Nucleus binds the current author's authenticated task-row or released revision
result and exact receipt to the retained workspace and PR, then verifies the
published source and relevant authenticated ancestry before binding identity.
The ancestry includes receipt-verified reviewer results in the retained workspace
even after the current review is cleared. An applied review with missing or
conflicting receipt evidence refuses.
An omitted report head is not inferred from its summary. This grants no ready,
review or merge credit; live participants and unsettled effects remain fences.

### Liveness and reminders

- A run whose agent shows no timeline activity for the stall threshold (default
  30 minutes) while Paseo reports it running is stalled and enters coordinator
  recovery, one incident per run. A permission pending past that threshold is
  the same stall: it raises owner attention and names the request. Nothing is
  auto-approved or auto-denied. Nucleus doesn't interrupt it and the lease holds
  until it stops. A missing activity timestamp is never stale. Merge lease wait
  text names a pending permission or question when the identity matches.
- A stalled turn stays attached to its exact identities until `restart`; Nucleus
  rechecks identities and fences before cancelling, and starts nothing
  automatically ([Spec 016](../specs/016-live-evidence-before-recovery.md) rule
  7).
- A shell command running over 15 minutes shows a notice on the task, recorded
  in the event ledger so it clears across restarts.
- Owner `restart role=worker` may supersede a stopped unreleased revision whose
  validation is still running, so the same worker can report when it finishes.
- Transport and login-session deferrals during a prerequisite wait are recorded
  as events and keep the task's phase and reason.
- An idle run or cleanly closed resumable session without a callback gets one
  persisted callback reminder. A live `effigy qa` or repository QA process in
  the worktree is liveness: the reminder is withheld and its grace extended
  (`callback_reminder_extended`). An incomplete process scan is `unverified`.
  The thread's own provider timeline is liveness too: a run whose latest
  non-turn-bound tool call is still running (a background shell, a timed test
  run under a Monitor, a worktree setup) is waiting on that job, not missing a
  callback. The task shows the wait, no incident or reminder is recorded, the
  reminder grace is extended, and no recovery run starts over it. Unreadable
  or inconclusive tool evidence is not liveness (papercut 6895edaa).
- Observation releases a superseded or replaced run whose thread its host
  reports archived or gone, using the same per-agent proof the archive path
  accepts. An unreadable read, a host without that answer or an inventory that
  does not mention the identity is unknown, never absence. The release records
  the terminal observation and clears a retained reviewer binding that names
  the thread, so no verb and no launch reuses it. The archive proves the thread
  ended, never an unsettled delivery or effect: a run holding one keeps its
  callback authority until that settles. The answer is evidence about the
  identity and lease it was read against, so a stop, a lease change, a service
  shutdown or any other substantive task or run write during the read wins and
  the release waits. A superseded run is never a relaunch
  target: its lease settles through the ordinary fence rule, and an ordinary
  `restart` then starts the next reader on the retained reviewer route rather
  than re-binding the historical run. A restart checks the durable fence and
  required liveness of the run it would release — the task's current reader
  included — whether or not that run is eligible as a relaunch target.
- A worktree-validation scan answers one question for one lifecycle pass and at
  most five seconds (`VALIDATION_SCAN_PASS_MAX_MS`), keyed by task, directory,
  selector argv and judged run; `unverified` is never shared. Consequential
  decisions scan afresh. A failed `ps`/`lsof` is retried once.
- For a blocked worker result the authenticated summary stays the task reason;
  a scan failure may show temporarily until a successful scan restores it.
- When a retained thread blocks dispatch, the reason names its pending
  permission or question, active turn or non-resumable status.

### Retained worker recovery

- `restart role=worker` with `fresh: true` (after `route role=worker` to change
  profile) replaces a worker that reports but can't finish, keeping task,
  workspace, branch and PR ([Spec 030](../specs/030-routing-changes.md)); never
  while a run is live. Until the replacement reports a PR, `resumePrNumber`
  keeps the PR identity.
- A proven transport-stopped or repeatedly non-responsive pre-PR worker may be
  retired by owner `restart`, excluding its profile and launching one
  authenticated continuation after continuation-worktree verification.
- `restart` on a pre-PR worker resumes the same retained thread whatever ended
  its turn: a blocked report, a provider error or a 429. The blocked or errored
  result may sit on the task row (the initial worker has no Run row) or on the
  worker's current revision run; both end the same turn, and a time or task wait
  that wakes the task applies the same restart.
- A recorded task workspace can be gone while its branch is still on origin.
  `move to=work` and `restart role=worker` then re-create the worktree from the
  published branch before touching the retained thread, keeping the task, its PR
  and its approval, settling the runs that lived in the lost workspace as
  superseded history, and starting the role on a fresh thread: a thread's cwd and
  binding belong to its old workspace (`task_workspace_recreated`). A
  registration whose directory is gone is re-created, never rebound to the dead
  folder. A worker continuation recovers from the newer of a surviving local
  branch and origin's advertised head, so an unpushed commit is kept and an older
  accepted PR head never wins; two lines with no fast-forward between them refuse
  rather than reset, and a deleted branch falls back to the accepted PR head. The
  accepted-PR reconciliation keeps that exact PR head as its target, because the
  review continues there.
- `restart role=worker` re-arms a pre-PR continuation parked behind a released
  prerequisite wait, minting a new revision on the retained worker.
- A pre-PR continuation establishes its first PR from the authenticated revision
  only after branch and exact-head verification. A stopped pre-PR revision is
  recovered on the same worker with its dirty workspace preserved.
- Stopped-revision recovery needs current PR, task and stopped run at one head.
  If an unauthenticated stopped revision pushed the branch, the owner may supply
  the inspected head; Nucleus accepts it only when PR, remote branch and clean
  workspace all equal it.
- An uncertain revision delivery is recoverable through `restart` only when
  non-delivery is proven: the worker is idle and its last message and activity
  predate the revision. Nothing is resent blindly.
- A report refused because a pending resume superseded its run names the resume
  and tells the worker to end its turn; the resume never bypasses a pending
  permission or question.
- Provider exhaustion (concrete quota evidence for the exact agent) or an
  operator-disabled group can replace a stopped agent on its workspace without
  discarding work.

### PR identity from reports

- Reservation requires the task version and run snapshot to remain unchanged.
  Before binding, Nucleus rechecks the same report, repository, branch, base,
  worker, workspace and head, and that no merge intent exists. For `move to=work`
  or `restart role=worker`, verification precedes cancellation. For `move to=review`,
  Nucleus observes again after cancellation and rechecks the task version, runs and
  ready result at the commit boundary; changed evidence refuses the transition.

- A PR the task knows only from a reported completion is an identity candidate
  and grants no review, validation or author credit (Tom, 2026-10-23).
- A revision dispatched on such a PR verifies it (identity, draft allowed,
  canonical head repository, continuation worktree) and binds `prUrl`,
  `resumePrNumber` and `prHead` with the run reservation, or refuses with
  nothing bound and no turn cancelled. Forks are refused.
- `move to=review` with no bound PR uses the PR the current ready result names:
  open, ready, on the task branch and base, at exactly the reported head, equal
  to the origin branch head and the clean worktree head, with retained workers
  observed inactive. Binding and review entry are one write
  (`move_review_pr_bound`); the caller never supplies a head.
- The current ready result is the latest released revision by the retained
  worker with an authenticated `ready_for_review` naming a PR and head, or the
  worker's own if there is no revision.
- A PR found by branch lookup is identity, never readiness (Tom, 2026-10-24).
  On a task with an authenticated block, reconciliation records only `prUrl`,
  `resumePrNumber` and `prHead` (`blocked_pr_identity_recorded`) and leaves
  phase and completion alone; the block stands until an owner verb or the
  worker's own ready result. The lifecycle classifies every parked blocked or
  error worker report through the blocker ladder, including an empty lookup or
  identity-only discovery. The ladder asks the task's own planner first and the
  project planner second, then the decider (task 1109). A classification wait is
  a lifecycle stop, not an operator question. A live recovery episode keeps the stop it was asked about;
  classification follows when that episode ends.
- A released, authenticated blocked revision can leave newer published work on
  the same retained branch. Before the next revision,
  Nucleus proves the canonical PR, retained checkout and author, matching local and
  published heads, and ancestry from recorded work. This is identity only: the
  blocked result and earlier review remain history at their original heads, and
  the new head needs an author's readiness and an independent exact-head
  review. A summary is never source proof. A recorded review fences continuation
  only through what proves it settled: a released reviewer run whose completion
  is that review's own event. Its verdict never does, whatever its status: a
  `blocked`, `changes_required` or `ready_to_merge` review at the older head all
  leave `move to=work` and `restart role=worker` free to continue the retained
  author on the newer head through the rest of the proof. With no review recorded
  the receipt check does not apply, as before. An approval at the older head is
  not an approval of the newer one: it stays at the head it judged, is dropped at
  the continued head, and merge still needs an exact-head review there (or the
  explicit owner source acceptance).
- A stopped callback-free worker with exactly one open non-draft PR on its
  branch gets that PR as provisional identity after strict branch, worktree,
  remote and base checks, and must confirm it through a read-only
  identity-confirmation run and a fresh `ready_for_review`. Restarting that run
  re-arms the same read-only intent.
- A superseded run can leave a clean, pushed head behind. When the open PR and
  the clean task checkout both report that exact head and no work is unresolved
  (no unreleased or uncertain run, no blocked or errored latest result), the
  differing forge head is adopted as observation: `prHead` is refreshed with a
  `pushed_head_adopted` event instead of refusing the restart as unbound
  retained progress. The underlying work still needs its own author readiness
  and an independent exact-head review; `next` offers `move to=review` at the
  adopted head. A dirty, unpublished or unconvincing checkout keeps the
  refusal, whose text names `move to=review` and `move to=work` as the exits
  (papercut b7a6fb99).
- Before returning a retained worker to revise its own bound PR, Nucleus verifies
  the PR is open on the task branch and base; a draft is allowed.
- PR branch mismatch recovery enters revision before mutation, and an existing
  canonical replacement PR is adopted only through strict branch, base, local
  and remote-head reconciliation.
- Branch-PR recovery continues a `changes_requested` task with dead revision
  runs: it needs escalated attention, a stopped retained worker, one matching
  branch PR and the head proofs, then releases only the dead leases, binds the
  PR and arms one readiness confirmation.

### Delegated answers preserve the planner's conversation

Delegated agent asks, blocker escalations, reviewer consults and operator-question
delegations climb one ladder (task 1109; Tom, 2026-11-11): the **task planner**
first, then the **project planner** when it is a different thread, then a
short-lived decider, then the board for operator-only kinds. A task planner is
the thread a brief named with `queue.planner`, else the task's owner — the thread
that submitted or promoted it — so reparenting moves it. A rung whose thread is
observed archived or gone is skipped at once; a live but silent rung still times
out, and an unknown send never advances. A project with no planner falls from the
task planner to the decider. The project planner keeps project-level matters:
lane drains, the plan and project notices. `task.next`, the board and the durable
question records name the rung that asked and the thread that answered.

Delegated agent asks, blocker escalations, reviewer consults and operator-question
delegations all use `nucleus question.answer`, authenticated to the calling thread
as owner verbs are. The payload carries the question ID, answer or choice, one-line
reason and optional exact `overtakes` IDs; repeat answers return the recorded answer.
Only an explicit `decision: "operator"` classification forwards a delegable question
to the operator, and operator-only questions keep their existing surfaces and authority.
A blocker escalation offers safe ordinary controls from the current `next` view, alongside
worker direction and stop. A proof-only task never offers a worker return; when a settled
receipt has no verdict, the escalation offers the receipt review instead. It does not delegate force, discard or source acceptance. A refused
choice is returned once to its asker; an unresolved action remains open. A wait must name a
prerequisite task, a future time or an open operator decision. Its wake resumes through the
ordinary controls; unknown wake delivery remains visible and is not replayed. The question,
answer and action are activity events. A coordinator refreshes its plan and retries an explicit
stale-version refusal once, with the original report binding rechecked.

Nucleus sends one short agent message naming the task, question,
choices and exact command. The recipient runs the command and writes nothing else
in the thread; standing rules belong in the skill. No chat output, `Ask:` matching
or reply re-presentation participates in settlement. Existing live threads learn
the command from that message.

The Paseo adapter sends as the asking agent, the reporting run for escalations, or
the task worker for delegated questions and notices. When no agent stands behind a
notice it uses the fixed sender `nucleus`. Source identity grants no authority.
The adapter checks for idle and no pending permissions twice before enqueue. Paseo
queues agent messages for about two seconds and clears pending permissions on
dispatch, so a permission arriving after the final check can still be denied; the
planner accepted this window on 2026-11-05. Busy time consumes the existing answer window and unanswered
questions still fall through to the decider. Host refresh and send share that
deadline: a stalled refresh releases the known-unsent wait, while an in-flight send
with an unknown outcome fences further sends until it settles. Durable send intent,
unknown-delivery handling and `delegated` authority remain in force; an unknown send
is never blindly repeated.

Recovery consumes durable command receipts without resending the question. An
answer received after restart within the recorded window is consumed through the
same route, with its original recipient and authority. A native permission response
records its own delivery intent before the host call; an uncertain response is not
sent again from that receipt. A completed planner or reviewer window is a miss for
that delegate, not the whole route: recovery advances to the next delegate without
resending or renewing the completed window. A completed full-route miss is terminal,
including when no eligible next profile exists; sweeps do not replay misses or
archive the same decider again. An unknown send is never blindly retried. See
[Spec 058](../specs/058-responsible-tasks.md#delegated-answer-command).

### Non-converging review ladder (Spec 058 cutover 3)

- Nucleus never upgrades a worker model automatically based on review history.
  A responsible task that does not converge uses the #584 ladder: worker,
  reviewer consult, planner, then operator when the planner forwards the
  question. The three-round question and revision-cap stop go to the planner.
- A planner who wants a stronger worker chooses it with `route role=worker`.
  The Spec 050 worker replacement rule creates one replacement when that route
  selects a different model, preserving the task, workspace, branch and PR.
- The lifetime revision cap remains six rounds (`REVISION_BUDGET`). At the cap,
  the task stops for the planner's delegated decision and proceeds one round at
  a time
  ([vision](../vision.md#reviewer-choice-review-loop-caps-and-coordinators-that-act)).
- Historical author-escalation rows are stripped from task rows (schema 54, task 989;
  the live rows held only empty defaults, so there was nothing of theirs to archive)
  and their events remain readable.
  The records no longer affect worker demand, routing or replacement.

### Worker replacement ceiling

An inactive errored worker's profile remains eligible for replacement: a
process or host failure is not a profile exclusion. An explicit model refusal
or invalid model configuration records a profile exclusion, visible in `next`;
an owner route lifts it. The same failed run does not recreate a lifted
exclusion. While the worker's subscription group or host catalog provider is
unavailable, automatic fallback stays at or
below the task's worker demand; an explicit route keeps its usual authorization.
If the required route is unavailable, failover records a provider wait and
retries when it returns.

Eight worker retirements is the automatic replacement ceiling and loop breaker.
Automatic failover, ordinary fresh worker restarts and `route role=worker now`
stop at that count. The operator can pass the ceiling by directly issuing or
relaying `restart role=worker fresh`; the operator relay is recorded on the
replacement arm and the existing worker replacement guard still checks the
route and cause. Once that replacement is consumed, automatic replacement
stops at the ceiling again until the operator relays another fresh restart.

Legacy task rows' `extraReplacements` history is stripped from stored rows (schema 54,
task 989); a replacement `authorizationId` remains parseable. Nucleus no longer reads,
reports, grants or spends that history.

## Review

### Independence and identity

- Reviewers are independent of every observed author model, including proof
  executors and escalated authors. Accepted reports, publication identity and
  exact-head verification gate merge.
- A repository opts into formal PR reviews with `repository.set` `reviewer:
  {login}` ([Spec 033](../specs/033-formal-pr-reviews.md)). Each accepted verdict
  is published as a GitHub review from that login pinned to the reviewed head
  (APPROVE, REQUEST_CHANGES or COMMENT), and merge requires that login's
  approval at the current head.
- The reviewer token is read at call time from the macOS login keychain (service
  `nucleus.github-reviewer`, account `<org>`; store it with
  `security add-generic-password -a <org> -s nucleus.github-reviewer -w`) and passed only to Nucleus's
  own `gh` calls; it is never stored, logged or given to an agent. A token kept
  under the legacy service `paseo-queue.github-reviewer` is still read as a
  fallback. A missing or refused token raises attention and never falls back to a comment.

### Review entry

- [Spec 017](../specs/017-external-pr-review-entry.md) review entry binds an
  open external PR in an existing isolated workspace with explicit planning,
  head and declared author evidence, without a fabricated worker callback. A
  Nucleus-held brief is verified and consumed atomically with binding.
  `shared_canonical` refuses with `exclusive_writer_unavailable`.
- The task uses one slot, starts with an independent reviewer, keeps revision
  workers in the same workspace and preserves the external workspace at
  cleanup.
- An author submitting during its finishing turn still binds the task; the task
  waits as a visible `origin_busy` stop until admission proves the writer
  yielded. Every fresh reviewer of a handover re-proves the yield and the clean
  head as its last awaited proof.
- The reviewer reads the task workspace at the proved exact head. This is not a
  writer lock; later gates keep refusing on observable drift, and a changed author
  refuses the verdict. A reviewer callback not bound to the task workspace and the
  current exact head is refused.
- A workerless review-entry task whose PR head changed outside the revision
  worker route cannot move directly to review. `move to=review` refuses and
  names `move to=work`, which starts the revision worker in the task workspace.
- A never-dispatched review-entry task whose PR merged externally keeps the
  separately bounded `move to=closeout` reconciliation and exact-final-head
  source acceptance.

### Checkpoints

- An authenticated `review_in_progress` checkpoint is saved evidence on the same
  exact-head run: no verdict, completion or approval. Each is persisted with its
  callback receipt and owner-only file; a checkpoint without receipt metadata
  refuses.
- Installed: Nucleus continues a reviewer checkpoint itself, within its budget,
  as a worker checkpoint continues (Tom, 2026-10-31,
  [vision](../vision.md#retained-reviewers-review-changes); supersedes the
  2026-10-18 coordinator rule). Once a fresh observation shows the reader idle,
  a wake applies the ordinary retained `restart role=reviewer` as Nucleus, not as
  the owner, so an owner stop hold, any dispatch hold, a pause or a recorded
  owner verb still holds it. A refusal records one `review_auto_continue_deferred`
  and waits for a later pass. An awaiting checkpoint is a lifecycle wait and
  opens no coordinator episode. The owner may still continue it with the same
  verb.
- Observation re-evaluates that wait even without a turn-end event: a recorded
  result takes the ordinary intake path, and another run blocking continuation
  settles through ordinary observation and release. After the stall threshold,
  `next` suggests the available owner verbs that can exit a queue-owned wait;
  holds and unknown effects keep their existing fences.
- `restart role=reviewer` binds task version, reviewer run, head and ordinal,
  proves the same reviewer idle and permission-free in its own workspace, model
  and runtime, and persists one authorized delivery before sending. At most one
  continuation is delivered per checkpoint; a replay reconciles it.
- A brief amended after the checkpoint doesn't block continuation; the reviewer
  is re-pinned once delivery is proven (Tom, 2026-10-18). A checkpoint past the
  budget is rejected and escalates to the owner. Its covered, remaining and notes
  are kept on the run as rejected-reading evidence (`reviewRejectedReadings`):
  never a checkpoint, never a continuation.
- The continuation prompt and `next` show the allowance used of allowed
  (`2 of 6 checkpoints used`). The continuation for the last allowed checkpoint
  says `6 of 6: this turn must end with a verdict`, because Nucleus refuses a
  further `review_in_progress` report there.
- An open incident fences a retained continuation only while it binds the
  current work; an incident recorded against a released run cannot hold the
  reader.
- A delivered continuation has had its turn. The exits are the reviewer's own
  verdict or next checkpoint, an owner `stop` of that turn followed by `restart
  role=reviewer`, `route role=reviewer` to a profile with capacity, or a fresh
  reviewer. Only a matching observation after proven delivery shows that turn
  stopped.
- One owner stop authorizes one resumed continuation (Tom, 2026-10-27): the
  authorization is one immutable `owner_stop_sent` occurrence for the same run,
  agent and workspace after the delivered turn. Stops written by `move` or
  `route` displacement, uncertain cancellations and idle observations authorize
  nothing. A resume grants no extra checkpoint allowance or credit.
- Runtime identity must be positively observed: provider and model must match;
  an unreported mode or thinking level is unknown, not changed. Configured or
  requested thinking never substitutes for an applied-setting observation
  (2026-10-19).
- A retained reader continues from either placement of its own checkout (under
  the canonical project, or a project rooted at the checkout). Cleanliness is
  proved, then the task/run/workspace binding and the checkout's Git source
  are re-proved as the last awaited proof before send.
- The continuation ends for good when the budget is spent or the reviewer's
  agent is positively observed closed (`retainedAgentClosedAt`, nothing else
  changed). `next` then offers `restart role=reviewer fresh` or `route
  role=reviewer now`; `move to=review` refuses and names that exit.
- A reader whose creation delivery stayed uncertain is continuable on the exact
  authenticated checkpoint evidence that proves creation reached it.
- Refusals before the adapter's send are definite failures. After the adapter
  enters send, an exception stays uncertain and settles only from the exact
  timeline message carrying that delivery's identity; idleness, a final callback
  or a checkpoint never settles an unknown send, and releasing a run settles no
  unknown send.
- An owner may return an idle checkpointed review to its author with `move
  to=work` (or `restart`), preserving checkpoint and callback history and
  superseding the lease without a fabricated verdict (2026-10-11). A changed
  brief needs separately recorded owner revision authority.

### Retained and replaced readers

- By default, `move to=review` preserves what it can continue (Tom, 2026-10-27): a valid
  retained reader at the exact current head is never replaced; an awaiting
  checkpoint continues through the ordinary retained-restart path. With no
  continuable reader at that head, it starts a fresh reviewer. Explicit
  `fresh: true` deliberately displaces a reader whose binding is proven, even
  when a checkpointed round already holds a result; its result and checkpoints
  remain history. It still refuses a reader whose binding cannot be proven.
- One identity derivation separates an absent reader (none, or another head), a
  valid one and a refused one (binding unprovable). A refused reader is never
  read as absent or displaced; the move refuses and names the deliberate
  replacement, `restart role=reviewer fresh` or `route role=reviewer now`.
- A fresh reviewer restart or a reviewer route that replaces the reader fences the
  replaced agent through its host before releasing the run. Saved checkpoints
  remain history and no longer pin ownership. On Paseo a stop awaiting inactivity
  records a ready archive so observation can finish the replacement. An uncertain archive
  retains ownership until observation confirms the agent is archived or absent; it
  is never blindly resent. On T3 the fence is a stopped turn observed idle,
  with the displaced run released and its late callbacks refused; the thread
  stays settled until closeout (T3 adapter spec, [thread
  lifecycle](../specs/t3code-host-adapter.md#thread-lifecycle)).
- Other replacement paths allow a working reviewer to finish (Tom, 2026-10-19; planner ruling
  2026-11-09 "replaced is not released"): replacing a reviewer marks its run
  replaced (`replacedAt`) without releasing it or revoking its credential; its
  checkpoint still applies as saved progress, and its verdict is accepted if it
  is at the current head and no verdict for that head exists yet — the first
  verdict at the head wins; a later reviewer's verdict ends the claim. The run
  is released, and its credential and tickets revoked unconditionally, only
  when the review settles: the replacement's verdict applies, a readopted
  verdict applies, or the replaced run ends without a verdict; after release
  nothing authenticates. A run already proven ended settles at replacement
  instead. A host's own answer that the thread is archived or gone is that same
  proven end, so observation releases the run and no relaunch names it again.
  Provider-refusal and quota replacements are not marked.
- A current reviewer whose own provider refused its dispatch turn (the canonical
  Cursor plan refusal or an attributed quota error in its own `ns-run-<runId>`
  turn) is replaced only after one read-only selection proves an eligible
  independent reader with the exhausted group excluded; quoted, partial or
  non-terminal evidence is `unverified`.
- `restart` may name `reviewer: {profileId, reason}`: Nucleus preflights the
  profile and its model's independence, proves the clean pushed PR head and no
  live tool in the stopped turn, then supersedes only the stopped run in the same
  transaction (Tom, 2026-10-13). Caller-asserted actor or relay fields are
  refused.
- An explicit `retireCheckpoint` opt-in retires a reviewer positively stopped on
  its latest authenticated checkpoint with nothing else outstanding.
- A replacement reader receives bounded attributed owner source context when the
  hashed control, its audit and a unique earlier reviewer instruction agree at
  the same head and brief; it is historical context, not instruction.

### External-owner recheck and partial readers

- A `restart` naming no role is the bounded recheck, offered to an owner and an
  authenticated coordinator alike; only `restart role=reviewer` continues the
  reader. The recheck retires a partial no-verdict reader whose creation
  checkpoint is authenticated and whose every delivery is settled
  (`partial_review_custody_settled`), keeping its history, then requalifies the
  original review.
- Requalification needs the shared checkpoint proof (accepted receipt hashing
  the callback, owner-only file, ordinal digest, run/head/brief binding), the
  original reviewed content and the receipt, fence, brief and author
  bindings pinned at admission, re-proved synchronously inside the commit after
  every awaited proof. The participant's idle, permission-free, tool-free proof
  is the last await.
- An unreadable observation is not drift: a Git ancestry command that could not
  run, an authority read that failed, a non-positive repository permission or a
  PR response missing fields keeps review credit and blocks the merge until a
  fresh positive proof. A concrete different value, or a closed, merged, draft
  or deleted PR, is drift; a task-version change never is.
- The integration base observed by the canonical proof is pinned for the pass;
  a local ref moving afterwards refuses. A positive source change seen by a real
  pre-send reviewer restart is recorded (`external_owner_source_drift_observed`)
  and blocks requalification even after a reversion.
- The reporting coordinator's own recovery run is exempt from the fence only
  through its strict binding (its accepted completion, receipt and the episode's
  pending restart action all naming it); any other unresolved run, delivery or
  effect still fences.

### Retained change review

Ordinary tasks retain the qualified reviewer across revision heads, with a new
run, credential and full exact-head verdict. The shared checkout is detached only
after custody and source checks, then restored to the recorded author branch after
release ([Spec 057](../specs/057-retained-change-review.md)).

The prompt supplies earlier findings, exact SHAs and the git commands that
read the delta in the reviewer's checkout; diff and range-diff text is never
inlined, at any size (Tom, 2026-11-01). A pure rebase gets a
confirmation turn with base movement and actual covering evidence; it gains no
cached approval. An authenticated environment block with source approval and
named proofs parks once in `awaiting_proof`; the existing owner proof activation
and same-head settlement lead to one independent evidence-only verdict. On a
responsible task the named proofs are routed to whoever can produce them before
that wait ([Spec 058](../specs/058-responsible-tasks.md) slice 8). Head
movement invalidates source approval and preserves the normal readiness gates.

### Mechanical integration without repeated content review

- A GitHub merge conflict returns to the retained author. If the revision
  returns the identical approved head, Nucleus keeps the exact-head approval and
  rechecks merge gates. A changed head is parked for an operator choice: one
  bounded proof review of a mechanical equivalence, or a full review (Tom,
  2026-10-08 and 2026-10-11). An author summary or old approval never authorizes
  merging different bytes.
- Repeated reviews of unchanged content to solve contention are not allowed
  (Tom, 2026-10-11). The mechanical review carry is deleted; its records stay
  readable.

### Verdicts and findings

- Ordinary `changes_required` findings return to the retained worker under a
  bounded semantic revision budget, as do administrative, operator-instruction
  and identity-repair revisions. (The pass-gate continuation named
  `revisionCause: continuation` is retired with the brief pass gates — Spec 058
  cutover 2; old pending continuations still park until an explicit operator
  revision, and the recorded cause stays readable.)
- The counter is charged when the first `review` revision run for one
  `changes_required` review is reserved, across authors and upgrades (task 576,
  2026-11-02): continuations of the same round — unfinished returns,
  non-delivery push-backs, owner-approved re-dispatches and pre-merge refusals —
  are not charged. At six, only a new substantive `changes_required` review past
  the cap parks the task: a responsible task escalates to the project planner
  through the blocker ladder as a delegated decision; the old lifecycle names
  the owner disposition. The accepted review
  and hook evidence remain recorded. Historical counts are not reset.
- Completed reviewer `blocked` and `error` reports are attributed impediments,
  not verdicts; they grant no approval or publication.
- An accepted `changes_required` verdict at the current head moves its task out
  of the review phase once its reviewer is finished: the phase follows the
  recorded verdict, and nothing is published, verified or credited again.
- The current review outcome is one derivation (`currentReviewOutcome` in
  `core/verbs/owner-verbs.ts`) feeding `task.next`, the launch snapshot and the
  coordinator refresh. It separates the accepted verdict (proved by its own
  `review_result_applied` event; `superseded: true` once cleared, with no merge
  authority), an unapplied reported result, the reader holding the current head,
  checkpoint coverage and the author's latest result
  ([Spec 050](../specs/050-owner-task-controls.md#verbs)).
- The outstanding decision is one fact, in order: a result awaiting
  publication, a newer reader at the current head, a later same-head author
  result, a live author revision, a deliberate fresh review awaiting its reader,
  else the applied verdict's branch. A finished or released run is never the
  active participant. An accepted verdict at an earlier head never qualifies a
  changed source, and an exhausted author allowance is the owner's disposition,
  never a reason for another review.
- Reviewer threads are released after their verdict is verified and applied, and
  the worker stays through revisions until closeout. A released support thread
  (reviewer, recovery coordinator, executor) is archived at once on a host that
  cannot remove a thread; a host that can (T3Code) keeps it settled and bound so
  the next round or episode continues the same thread, and removes it at closeout
  (`Host.deleteAgent`; T3 adapter spec, [thread
  lifecycle](../specs/t3code-host-adapter.md#thread-lifecycle)).

### Publication recovery

- Publication intent at a previous PR head remains history and cannot block or
  offer settlement at the current head. Review credit still binds to its exact head.
- A reviewer waits while recovery effects block dispatch; it does not repeatedly
  create runs until those effects change.

- `retry_effect review_publication.<runId>` (with a `reason`) observes the
  publication and binds a found review or retries after fresh complete inventories
  prove its marker absent. A failed attempt does not consume future retries.
  This works from parked phases too. Force is refused: use ordinary
  `retry_effect` to publish the retained verdict; it cannot be discarded. It never launches a reviewer or worker, and a
  failed JSON response is not a missing callback.
- Both verdicts use this path with their exact findings bytes; a body mismatch
  stays uncredited.
- A recorded result stays one stop across restarts; a real late callback still
  resumes ordinary handling.
- For an owner-chosen author return, `move to=work` settles a completed recovery
  whose agent is freshly idle and records revision intent under the dispatch
  hold; the holder releases separately.
- An authenticated result from a stalled run supersedes its escalated stall once
  that run and any recovery coordinator have released; a publication fault stays
  an owner-held incident.

## Merge and closeout

### Integration turn

- An accepted exact-head review survives unrelated base advancement. Reviewed
  tasks take a per-repository FIFO integration turn held through verification,
  merge, synchronization and closeout; a changed base refreshes verification
  against the unchanged head without a rebase unless GitHub or branch policy
  requires one. A local integration base that origin has moved past is
  fast-forwarded by the gate itself, at most three times per pass, and parks
  for an operator only after that bound ([repository hooks](repository-hooks.md#prospective-merge-target)).
- Uncertain unlanded merge responses use the bounded proof and single guarded
  re-issue of [Spec 038](../specs/038-bounded-uncertain-merge-reconciliation.md);
  every fresh-gate hold in that recovery shares the 30-minute bound, after which
  Nucleus escalates; an unresolved merge intent keeps the turn until its
  outcome is settled.
- Merged-task closeout may pass an earlier parked verification that is idle for
  the turn, with no live run, recovery or merge intent (Tom, 2026-10-11). Such
  a verification holds no slot; a durable repository reservation binds the
  closeout and the bypassed tasks before any await. Unmerged tasks keep FIFO.
- A task's turn ends at its closeout, not at the end of its quantum (Queue
  #705). Once `closed_out` is recorded at a synchronized merge the task holds no
  turn, and the earliest holder is woken at that write instead of at quantum end
  or a sweep; the finished task's thread and workspace cleanup keeps running
  without holding it (Queue #674). An unknown merge delivery, an unsynchronized
  merge, an unresolved operation and the closeout reservation still hold the
  turn, and the order stays FIFO.
- Mechanical verification waits reserve no agent admission capacity;
  integration-turn ordering remains separate.

- A task unable to act because of a blocking recovery effect, unresolved
  operation or publication, attention, escalation, hold or pause yields while
  keeping its FIFO sequence (Tom, 2026-11-04). Active integration work keeps
  the turn through its awaited response; a possibly delivered merge never
  yields on uncertainty, and a returning task re-proves the current base gates.

### Merge gates

- After an accepted review and reviewer release, a required read-only
  `task.pre_merge` hook runs against the clean reviewed head or a Nucleus-owned
  checkout of the prospective merge result
  ([Spec 007](../specs/007-reviewed-head-pre-merge-hooks.md),
  [Spec 015](../specs/015-prospective-merge-pre-merge-hooks.md)). Base movement
  invalidates a prospective result without a refusal. A confirmed refusal
  returns the PR through the revision loop; uncertainty holds.
- Nucleus then mechanically checks the submission approval, accepted review
  evidence, PR head and base, required checks, mergeability, the FIFO turn and
  task identity, with no verification or coordinator run. One fresh merge-gate
  observation and one review-entry source check lead directly to durable merge
  intent in the same pass; a moved prospective base rebuilds the candidate.
  Stored mechanical verification never grants permission after restart: an
  unrequested merge repeats the prospective preparation and fresh gate. Gate
  reads share PR identity and branch requirements only within that attempt;
  independent forge reads run together. Attempt-step and forge-step durations
  are recorded separately; overlapping forge durations are not additive.
- A failed required check is a semantic refusal: the PR returns to the worker
  with each check's name and job URL. A revision returning the same head with
  identical refusal evidence buys no second round, including conflicts and
  repository pre-merge refusals. Nucleus uses the recorded author-run head and
  verified PR head regardless of report fields or intervening reviews. The
  review stands and the task parks through the blocker route, with
  `move to=merge` (with `force` where required) and `move to=work` as exits.
  Alternating refusals are compared across the unchanged-head episode.
  Changed evidence, a changed head or an owner instruction gets another round;
  a total run count at one head does not distinguish those useful rounds.
- A pending check is re-observed every minute at the same head and yields the
  integration turn; when checks settle, Nucleus reacquires a turn and reruns every
  gate. An overdue check gets one coordinator recovery look per check and head,
  then remains a visible wait. A queued job still without a runner after an hour
  raises planner attention once; repeats do not reopen recovery.
- A QUEUED check stays a pending poll. A CANCELLED check is infrastructure only
  with positive pre-run evidence (empty Actions step list or a
  runner-acquisition annotation); the first proven runnerless cancellation
  records durable intent and dispatches one head-guarded rerun, then escalates.
  Infrastructure handling never revises the worker.
- `checksPolicy: "required"` makes checks GitHub does not require for the base
  branch advisory; `all` (the default) keeps every check blocking. Requirements
  are read from branch protection and rulesets on every gate read; only an
  explicit "not protected" answer or an empty ruleset page is an empty set, and
  any other unreadable answer holds. Advisory failures are recorded as bounded
  evidence, never an author return or rerun.
- The merge gate treats GitHub’s explicit private-repository plan refusal as
  no strict rules for either branch protection or rulesets. Other unreadable
  strict-rule answers hold the gate. A strict-rule refusal waits for the other
  merge-gate reads, including the integration checkout read, to finish before
  returning.
- A merge counts only for the task whose head was reviewed (task 993): the
  merge gate refuses a PR whose base..head range carries commits from another
  unfinished task's recorded head that are not on the base, naming that task
  (papercut 4ec34bc2). The refusal routes through the ordinary pre-merge
  revision: the author rebases onto the base without them, or the planner
  orders the tasks. A recorded head already on the base carries nothing; a
  partial carry counts like a full one. An ancestry read that cannot prove
  absence parks visibly instead of merging.
- Activating `checksPolicy: "required"` is refused unless GitHub's requirement
  surface is positively readable for the canonical repository; plan or
  visibility refusals are reported as unsupported. A successful read only
  permits the setting.
- The policy and its settings revision are read at every gate and revalidated
  before durable merge intent and inside the guarded merge request; a settings
  write during an observation makes it stale. A re-issue after proven non-merge
  runs only under the current policy and the intent's recorded base.
- The manual verification oracle is retired (Spec 058 cutover 2, 2026-11-02):
  no evidence-only coordinator verification run is created any more. Post-review
  verification is Nucleus-owned mechanical gates over durable evidence, and
  closeout keeps the review summary. Stored rows that recorded the retired
  submission flag keep parsing.
- The `verification` run role is gone (nucleus#765). The one stored run and the
  one stored `resolution.verification` belong to a task finished in 2026-09, so
  the role, the `verified` status and the field stay in the schemas only so old
  rows parse. Nothing sets the field except a null on each new supersession, and
  only the task projection reads it. Three checks still refuse the role, because
  a stored row must never read as a closeout: `launch`, the result step and
  `runPrompt`.
- An external-merge pre-attention reason is saved and preserved verbatim with no
  separate length cap (2026-10-12).

### Owner acceptance

- With an explicit `qualification`, `move to=merge` records one durable owner
  acceptance at the exact current PR head over an authentic released reviewer
  verdict (Tom, 2026-10-17), writing `owner_acceptance`. The verdict and
  findings are never rewritten and no `ready_to_merge` is synthesized.
- Authority is the operator at the board, or an authenticated relay of the
  operator's ruling with its recorded note (Spec 058 cutover 5: the Spec 042
  project-owner authority is retired, and a caller claiming it is refused like
  any other non-authority). A delegated ladder answer accepts only where it is
  named. A coordinator cannot grant acceptance.
- Gates read the acceptance where they read approval; required CI, pre-merge
  hooks, merge holds, forge identity and effect fences stay real. A changed head
  invalidates it for merge.

### Operator source acceptance

- When no review evidence binds the current head (no verdict, an unfinished or
  unpublished one, or a head a docs-only conflict resolution moved),
  `move to=merge` may record an explicit operator source acceptance (Tom,
  2026-10-20). It binds task, repository, PR, head, actor, authority, ruling,
  qualification, existing findings and the missing evidence Nucleus derives, and
  binds no review identity.
- A ready current-head approval keeps the ordinary path, and publication
  reconciliation stays the route for an unpublished verdict. A source change
  invalidates the acceptance. `next` names the missing evidence.
- An acceptance may name the exact PR `head`; it must equal GitHub's open PR head
  before anything is displaced and just before commit, and is adopted only in
  the acceptance transaction (`owner_head_adopted`). Without it, a moved head
  refuses and names the head to pass.

### External merge

- A freshly observed external merge advances to syncing and closeout only when
  recorded review evidence binds the merged head (task 993): an exact-head
  `ready_to_merge` verdict, a reviewer source approval awaiting its proof at
  that head, a qualified owner acceptance bound to the recorded review, or an
  explicit operator source acceptance. Otherwise Nucleus records the merge as
  an observed fact (`external_merge_unreviewed`), supersedes the quiet runs
  the advance would have released, and stops the task for its planner through
  the blocker ladder — never the operator. `next` offers the existing routes:
  a fresh review of the merged head (`move to=review`) or an operator source
  acceptance (`move to=closeout`). Nothing is advanced, reverted or synced,
  and a repeated observation attaches to the open escalation instead of
  asking again. An already-recorded merge re-entry never re-decides an
  accepted route, so the gate lives on the fresh observation only. A
  submission that explicitly skipped PR review keeps its previous merge
  behavior, the same rule the Queue-owned gates apply.
- `move to=closeout` (reason required) closes out an external merge at a head
  that descends from the recorded work and records both heads. It may settle
  stopped leases only after two inactive, permission-free observations and an
  atomic unchanged check; callback-free stopped leases become superseded
  history, never a verdict (Tom, 2026-10-07).
- For a dispatched task merged at a descendant of its clean source, the same
  verb can record an exact-final-head operator source acceptance; `next`
  offers it as one all-or-none `qualifyingFill`.
- A queued review-entry task that never ran can be reconciled by `move
  to=closeout` only with an exact-final-head operator source acceptance of the
  observed merged head, which must descend from the intake head and the latest
  recorded head. Nothing is created and no credit is inherited; the recorded
  head stays that route's decision.
- Merge and closeout liveness covers the task's bound workers, reviewers and
  proof executors, including retained runs; owner, coordinator and submitter
  roles are not participants by role alone (Tom, 2026-10-30).
- A transient external-merge check parks the task with its pre-attention phase;
  the next probe finding the PR open restores it and resolves only the matching
  reviewer incident (`external_merge_check_incident_resolved`).
- The automatic probe reads the forge at most once per two-minute window per
  task while its lifecycle identity is unchanged; a skipped read is "no merge
  observed". Owner verification paths are never held by that window.

### Closeout and outcomes

- Closeout authority is `queue`, `hook` or `agent`, chosen from the control
  manifest at the synchronized integration commit. A repository without a
  manifest gets Nucleus closeout, overridable per repository in
  `repository_settings` ([Spec 022](../specs/022-queue-projects-without-manifests.md)).
- Nucleus closeout writes the outcome row and moves to `done` in one transaction,
  with no run, workspace, hook, commit or push.
- Hook closeout, for consumers on the legacy Northstar layout, publishes
  Markdown under `docs/logs`, `docs/roadmaps` and `docs/handoffs` plus the root
  `docs/README.md`, then verifies pushed state. Agent closeout is the manifest
  fallback when no closeout hook is bound.
- Every terminal path writes one host-neutral outcome row in the terminal
  transaction. Outcome rows are permanent; completed live-task history expires
  after 4 days (Tom, 2026-10-20) with unresolved effects protected.
- Owner `complete` finishes a task with no PR to merge: a `reason` and optional
  `artifact: {key, version, digest}`. It refuses only a terminal task, merge
  intent, an open PR or an active live run, and writes a `done` outcome with
  `pr`, merge, review and closeout absent. A matching unanswered
  report-disposition escalation is answered in the same transaction. Portable
  outcomes carry the artifact in `reason`.

### Repository hooks

- A repository may declare generic hooks in `.paseo/queue.json`
  ([Spec 001](../specs/001-generic-repository-hooks.md),
  [repository hooks](repository-hooks.md)). Nucleus pins manifest, executable,
  instruction artifact, event and clean base before direct no-shell execution;
  read-only hooks preserve Git state.
- Installed: integration-write hooks use the repository turn and Nucleus-owned
  exact-path commit and push. Approved, not yet built: the integration-write
  mode, its publication and closeout authority are to be retired (R5,
  [vision](../vision.md#simplification-rulings-2026-10-31)). The trusted runner
  approval registry is retired; hooks can name host tools directly.
- Required failure holds its transition; advisory failure advances after
  clean-state proof. Every effect has durable intent and uncertain outcomes are
  reconciled before retry.
- A required integration-base occurrence held only by a clean base advance is
  replayed automatically under one exact-identity, absence-of-effect proof, at
  most two advances per event ([Spec 010](../specs/010-automatic-exact-identity-hook-replay.md)).
- Without a manifest no repository hooks run. Nucleus never parses Northstar or
  any repository document system.

### Cancellation and disposition

- Cancellation and supersession run through one durable disposition fence
  ([Spec 003](../specs/003-post-dispatch-task-disposition.md)): a versioned
  action records kind, reason, replacement and work disposition before any stop
  or archive. Drain interrupts active turns, waits until each is proved stopped,
  then releases leases.
- Bulk disposition fences an explicit task set atomically, then drains
  serially with durable per-target progress.
- Only proved-empty Nucleus-owned workspaces are archived; adopted, shared,
  dirty, PR-backed or uncertain work is preserved. `task.cancelled` fires once
  before terminal `cancelled`. A completed disposition derives no further work.
- An answered escalation is closed by one versioned operator-only control with
  a reason, keeping the escalation event, when no run is unreleased and no live
  work backs it ([Spec 016](../specs/016-live-evidence-before-recovery.md) rule
  6). Never available to a coordinator.

### Telemetry

- Nucleus records a telemetry boundary whenever the lifecycle stage changes;
  telemetry derives from existing events without parsing titles or documents
  ([durable telemetry](durable-telemetry.md)). Recovery provider attribution
  follows the affected role run.

### Stop active threads while paused (Queue #650)

- While Nucleus is paused, the operator can stop every remaining active thread
  now. One service method (`queue.stop-threads`) serves the board menu and the
  CLI; it is an operator control, and refuses unless Nucleus is paused
  ([Spec 058](../specs/058-responsible-tasks.md) slice 19).
- The control cancels every live Nucleus-owned agent turn — workers, revisions,
  reviewers, executors, recovery and closeout coordinators, and proof-only runs
  — through the existing durable stop path (observe, `paused_stop_intent`,
  cancel, `paused_stop_sent` or `paused_stop_uncertain`). An unreadable or
  mismatched identity is never stopped. Worktrees, branches, PRs, uncommitted
  work, review state and every hold are kept; no dispatch hold is added, and
  planner and other non-Nucleus threads are never enumerated. A thread whose turn
  settles during its cancellation (a late callback or a release) keeps its
  ordinary handling and is never marked.
- Each stopped run records a `paused_stop` marker (operator, time, run, agent
  and role; the task row carries it for the initial worker thread). An
  unresolved marker proves the stop was deliberate: the callback reminder, the
  closed-reviewer reconciliation, the transient-provider resumes and the
  failover arms all yield to it, and no budget, retry or replacement counter
  moves. The task names a typed `paused_stop` wait until the thread resumes.
- On unpause, Nucleus resumes every marker in its own agent thread, oldest stop
  first: one continuation turn telling it the queue was stopped and it should
  pick up where it left off — the same retained-thread continuation a `restart
  role=…` (not fresh) delivers, never a new run, so capacity, budget and
  replacement counters stay as they are. A continuation keeps the thread's own
  existing slot; pacing is the resume pass's sequential oldest-first order, not
  the dispatch funnel's capacity pacing. That includes an agent the daemon
  closed meanwhile whose session persists. A thread that cannot be resumed, or
  whose provider failed, is replaced under the ordinary rules (#577/#605/#610):
  the worker or revision arm is the ordinary failover sweep, and a reviewer or
  coordinator falls back to the ordinary stopped-run handling. An uncertain
  delivery retries in place with the same message identity (three attempts)
  before that arm. The marker clears once the run resumes, and the audit pass
  settles any resume the unpause moment could not finish.
- The board shows how many threads were stopped and, after unpause, how many
  resumed or are waiting to resume; each task card shows "Stopped while paused"
  until its thread resumes.

## Responsible tasks (Spec 058, cutover 1)

- Every new task runs the responsible lifecycle. An absent `queue.responsible`
  means true; an explicit false is refused. The persisted field stays optional so
  historical rows and their frozen submission identities remain readable.
- Tasks have no per-task coordinator in their ordinary lifecycle. The
  retained reviewer and the worker exchange findings and fixes through the ordinary
  `changes_required` revision and returned-head review rounds. Reviewer approval at
  the exact head plus the mechanical merge gates merges; there is no default merge
  hold (a hold is still another thread's Spec 040 gate) and no verification run.
  `queue.manualVerification` is refused at intake because the verification
  coordinator is retired (Spec 058 cutover 2) and cannot select another
  lifecycle; stored rows keep the optional field readable.
- When Nucleus refuses a worker's ready report because its PR is closed,
  draft, or mismatched to the task branch or base, it returns the reason and a repair
  instruction to that worker in a fresh revision run. The corrected report names the
  replacement PR and goes through the same strict identity check before review; no
  recovery run is opened.
- A worker model with attributed provider quota exhaustion is routed by the ordinary
  failover sweep, on the same task and workspace, with no coordinator. A reviewer
  that stopped without a verdict (agent observed closed, or stopped with no
  continuation) is replaced by code through `restart role=reviewer fresh` at the same
  head, once per stopped head. A second stop at that head, or any fault code cannot
  settle, opens one retained recovery run (Spec 058 Recovery).
- After three substantive `changes_required` reviews without convergence the task
  does not upgrade its author. Nucleus writes one durable `responsible_question`
  intent, prompts the task's own thread to raise one native Paseo planner question
  carrying the reviewer's authenticated full finding (`reviewText`) and the worker's
  last return, and waits in the
  `responsible_question` stop. Answering it clears the stop and the next round
  continues in the same worker thread; an interrupted observation records
  `responsible_question_unknown` and is never resent.
- A task over its effective-token or wall-time budget (Spec 058 slice 6)
  starts no new run after the one in flight. The launch funnel stops it with the
  `budget` reason and raises one native operator question on its own thread: extend
  (one default increment), change the approach (the answer is the worker's next
  instruction, with the same increment) or stop and keep the work (owner `stop`).
  An interrupted observation is `operator_question_unknown` and is never resent. A
  budget stop always names `extend_budget` in its `suggestedVerbs`, and its question
  is raised from the task's own pass as well as the sweep's question step: a phase
  that records the pause, a task host that is offline (the question then goes to the
  board), or a support step that failed earlier in that sweep cannot leave it silent
  (nucleus#1153).
  Every task is subject to the responsible budget.
- Wall time charges the task's own work (nucleus#1153). Each task quantum settles
  `resolution.budgetClock`: it opens an interval while the task waits on a
  Nucleus-side cause — a recorded `external_unavailable`, `workspace_unavailable`,
  `route_unavailable` or `provider_unavailable` stop, an unresolved
  `workspace_state`/`uncertain_delivery` incident, a proven pre-send refusal that
  parked the task in attention (held until an owner resume resolves the episode), a
  dispatch hold (which blocks every run the task could start), or a sweep
  `observation_outage` on its lane — and closes it when the task can make progress
  again. An outage pause opens on the first observation, while the lane is still
  wedged, is dated from that observation, and only that quantum's own return closes
  it, so a return that beats every sweep visit still books the whole outage. Closed pauses are durable, recorded
  as `budget_clock_paused`/`budget_clock_resumed` (and `observation_resumed`) events,
  reported as `wallMs.pausedMs` on the detail and named on the budget's time bar, and
  subtracted from the wall figure, so a defect never spends a task's budget. A budget
  pause, a merge hold, capacity queueing and the task's own validation keep charging.
- Any thread registers itself with `task.register` (Spec 058 slice 4): the worker
  is the calling thread, bound to its own live worktree, always responsible, with
  no planner, owner or coordinator. Identity comes from the authenticated thread,
  never a typed name; the worktree must be a clean separate worktree on a branch
  of a registered repository, and checkout, detached, dirty, foreign or
  already-owned registrations are refused with the reason.
- The old `set_responsible` control, native conversion question and
  `queue.responsible-convert` RPC were removed in cutover 1 (Spec 058); historical
  rows and frozen submission identities remain readable.

## Coordinator and owner verbs

### Verbs

- Owner task controls are the verbs ([Spec 050](../specs/050-owner-task-controls.md)):
  `next` (read), `route`, `restart`, `move`, `stop`, `complete`, `retry_effect`
  and `proof`. Every verb derives its identities from the task, writes one
  `owner_control` event, and changes nothing when refused.
- `next` and execution share one task-scoped plan (Tom, 2026-10-27): the
  continuation a view offers is the one the transition applies, and no verb is
  refused for a fence its own transition settles.
- Kept controls: `set_routing` and `exclude_worker`; holds,
  dependencies (`set_dependencies`, `set_prerequisite_wait`), `set_lane`,
  `amend_brief`, `promote` and cancellation keep their own actions. Narrow
  aliases were deleted (Tom, 2026-10-15 and 2026-10-19,
  [retired](../retired.toml)). The named-agent `coordinator` action was
  deleted 2026-11-06; `route role=coordinator` assigns.
- A checkpoint continuation is `restart role=reviewer`. On a blocked reviewed
  task, `restart role=reviewer` with an `instruction` returns it to fresh review
  after PR-head checks. A parked task restarts from its parked result. A durable
  restart schedules another task pass after its operation effect settles, so the
  operation's own integration fence cannot consume the requested recheck.
- An escalation is answered by the owner's next verb; when nothing else
  applies, an owner `restart` answers it with its `reason`. A coordinator's
  restart never does.
- `restart` replays validation for a settled pre-dispatch task: no unreleased run,
  live worker, worker intent, or PR. Released run history of any role does not block
  it, and validation retry applies the same rule the restart shape uses (nucleus#1147,
  #1163). A parked restart's refusal is definite at
  read-only verification; uncertain delivery still fences the control
  ([Spec 012](../specs/012-durable-asynchronous-operations.md)).
- A `restart`, `route` or `move` whose launch is fenced or deferred names the
  run or hold that fences it and what releases it, in its own reply and in the
  reason `next` reads. None of them reports success for a launch that started
  no run.
- Worker restart availability follows the task binding and effects, with a
  fresh observation at apply time; saved activity never releases a lease or
  cancels healthy work.
- Retained PR routing into review (Tom, 2026-10-19): `move to=review` derives
  the retained PR from task state; a different `prNumber` can't replace it.
  Nucleus verifies worktree, branch and open ready PR at one head and observes
  workers inactive, then binds and settles in one transaction. The owner grants
  no verdict, validation or merge credit.
- A queued review-entry task bound to its external workspace counts as
  pre-dispatch for dependency correction until anything has run.
- A reported restart may name the role a view left open (a blocked or errored
  task with a PR leaves the worker/reviewer choice to its caller).
- A stale coordinator report never blocks or overwrites an accepted result. A
  pending legacy recovery action on a released run is recorded as not applied,
  with its escalation kept.

### Routing issues

- Operational issues go to the task coordinator first, then the project's
  planner through the blocker ladder on a responsible task (Tom, 2026-10-13
  coordinator-first rule; the Chatterbox routing hub it once named is retired
  with project ownership, [Spec 058](../specs/058-responsible-tasks.md)).
  Escalation to Nucleus's owner is for a missing or
  broken Nucleus capability; a new operator decision goes to Tom.
- A worker's own `blocked` report on the old lifecycle goes straight to the
  escalation path with no coordinator run (Tom, 2026-10-15); a responsible task
  asks in turn and climbs the ladder instead. A worker `error` and other roles'
  reports use the coordinator path.
- Routing a waiting role to an available profile is the coordinator's job
  (Tom, 2026-10-19).

### Coordinator reports

- Nucleus records one current stop per task (`{reason, detail, since,
  suggestedVerbs}`). A coordinator returns one typed `coordinatorAction`
  (`restart`, `route`, `move`, `retry_effect` or `cannot`) with its recovery run
  identity; Nucleus applies it through the shared verb registry. A report without
  the structured action is refused at intake with its shape. A `cannot` over a
  still-bound initial or revision worker waits for that worker after a fresh
  matching agent and workspace observation; otherwise it escalates to the owner.
- A coordinator cannot grant acceptance or relay an operator replacement instruction.
- A report binds to its episode, coordinator generation and the task's progress
  when the episode opened (phase, head, worker, completion and review, run,
  merge state, routes, instruction source). Progress since then makes it stale.
  The guard carries no review coverage, so a retained reviewer's further
  checkpoint at the same head is not progress.
- A stop that churns between a wait and a stop for one condition is not
  progress; the reported verb applies if `next` offers it now. The digest is
  rechecked at commit after every asynchronous observation.
- Settlement and displacement need a positive agent/workspace match; a failed
  lookup refuses, and a matching live turn is cancelled first. Displacement
  never cancels the reporting coordinator's own turn.
- Launch context is the task-scoped plan `next` derives, snapshotted for the
  stop asked about; the coordinator refreshes it through `next`.

### Coordinator loop breaker

- Coordinator recovery never loops (Tom, 2026-10-19 and 2026-10-27): after three
  coordinator runs for the task's current work identity since the last
  deliberate re-arm, Nucleus launches no further coordinator and escalates once to
  the owner.
- Work identity is the exact head, the approved instruction source, the merge
  state and the maximum accepted checkpoint ordinal across all reviewers at that
  head. A change to any of these resets the count; a routine retained restart,
  route change, bookkeeping success or new reviewer identity does not.
- Only the owner's explicit `restart role=coordinator`, for an episode the
  breaker stopped, re-arms it, recording `coordinator_rearm` in the same
  transaction. The count, its basis and the exhausted stop show in `next` and
  task detail. No other ledger or setting exists.
- A launch without a recorded identity is charged while it stands at the current
  head unless cross-reader coverage demonstrably rose after it.

### Routine faults

- Routine faults reconcile inside Nucleus without a coordinator. A daemon
  transport drop never parks a task, and a parked task with a live worker
  resumes.
- Every fault opens one durable incident per task, role, run, attempt and cause;
  repeats update it. Notices go out only when automatic recovery is exhausted or
  a judgment is needed, deduplicated per incident; a new incident after resumed
  work can notify again.
- Integration-checkout contention (dirty, switched or behind canonical
  checkout) is one repository-scoped episode: tasks stay put and Nucleus retries
  quietly for five minutes, then only the episode leader enters recovery.
- An open incident binds the work of the run it names. An incident whose run is
  released neither holds coordinator attention nor selects a restart shape.
- An attention notice states the current stop. A resolved recovery episode,
  including an action recorded not applied because an owner verb superseded it,
  is history and is never quoted as a live blockage.
- After the grace, one complete exact lookup resolves an uncertain creation: a
  single match binds; proven absence revokes the callback and issues at most one
  same-role replacement; ambiguity escalates.
- An uncertain reviewer or coordinator creation with no agent ID stays fenced
  until a versioned operator action proves zero matches, revokes the callback
  and launches one fresh run. A failed recovery-coordinator creation is
  reconciled only when its error is recorded and its generation is current.
  Generic retry never clears an unresolved creation intent.
- A decision that escalates, spends a coordinator run or returns work verifies
  live the facts named in Spec 016 rule 4, once per attempt; a failed read is
  `unverified` and retries within a bounded grace
  ([Spec 016](../specs/016-live-evidence-before-recovery.md)).
- Exhausting the semantic budget, broader scope or an authority conflict
  escalates for coordinator judgment. A successful operator resume closes the
  prior incident and episode.
- Recovery coordinators stay bound across attempts for one issue, and the next
  attempt is dispatched into the retained thread. On a host that can remove a
  thread, a fresh coordinator is selected only when that host reports the retained
  thread removed or archived, or when a recorded coordinator route (`ownerRoute`,
  or a required request the operator honoured) names a different profile than the
  bound one: a different model needs a new thread. The displaced thread is kept
  and removed at closeout, never archived while the task is open. On a host that
  cannot remove a thread nothing changes: a bound coordinator that is not idle
  waits, a recorded route never displaces the binding, the retained thread is
  archived after the episode retires or the escalation is answered.
- While two faults are open on one run, the first reason stays on the task and
  the later one is recorded as an event.

## Durable effects and unknown delivery

- Effect classification follows the proof, never the diagnostic's words: a
  refusal a typed gate raises before Nucleus bound or sent anything is a definite
  failure, and a durable receipt it could not record never turns it into an
  unknown delivery (Tom, 2026-11-01).
- Commands are accepted durably before remote work
  ([Spec 012](../specs/012-durable-asynchronous-operations.md),
  [Spec 013](../specs/013-standalone-queue-service.md)). One operation record
  carries a caller key, kind, normalized input digest, task and version, state,
  attempts, diagnostic, result and any external-effect intent.
- Acceptance is one short transaction: the same key and input returns the same
  operation, the same key with different input fails closed, and saturation
  returns `backpressured`. No caller may infer failure from a disconnected
  response. Legacy adapters key versioned controls by the full input digest.
- Keyed lanes run one bounded lifecycle quantum per task and share the task's
  lane with its commands; a stale version fails before effect. Detached wakes
  queue on their lane, and each quantum starts without the caller's async
  context. Only same-lane re-entry runs inline. The scheduler yields between quanta. A cursor-sweep audit is the restart and missed-signal
  fallback, and unfinished operations resume from stored identity without
  reissuing an uncertain effect.
- A reported turn is observed on its task lane when a callback or Paseo
  lifecycle hint wakes it. If still active, up to five task-local follow-ups
  run after 2, 4, 8, 16 and 32 seconds; a persistent wait returns to the
  safety sweep. Each observation uses normal admission and never releases a
  run without the existing idle and identity checks. Concrete settlement,
  publication and application progress schedules the next task quantum;
  a released slot wakes an eligible waiter through the usual fair admission.
  Delayed timers do not hold quiesce open and are cancelled on stop.
- A run result's `run_result_applied` event is written in the transaction
  that applies its transition. An overlapping pass checks the event and the
  current binding before changing the task. Recovery owner verbs first record a
  durable `run_result_applying` claim. A completed verb outcome settles that
  claim; without an outcome after interruption it remains uncertain and is not
  resent blindly. The owner can inspect `next` and use the ordinary controls to
  settle the episode.
- One reviewer run's verdict is applied once, whatever passes overlap. The fence
  is the run's `review_result_applied` or `review_reapplied` event (for a
  proof-only task, its `proofOnlyResult`), read and written in the same
  transaction as the verdict's state. It holds across overlapping passes,
  connections and restarts and does not rely on the task lane. A pass that finds
  it changes and writes nothing, so a run reserved since the verdict keeps
  `currentRunId`. A pass joining a run's publication flight reports no
  publication of its own, so one review leaves one `review_published` event.
- LaneScheduler `quiesce()` (and so Engine `wake()` and `stop()`) waits for
  active and queued lanes, scheduled lifecycle follow-ups and a `wake()` that
  has not yet started its drain; it is not a global writer lock or proof of
  external settlement. A call inside a lane excludes its own lane to avoid
  waiting for itself; the wake drain excludes the audit lane.
- Nucleus classifies Git lock contention, definite SSH refusals, GitHub 5xx
  and connection failures at the command boundary. A task or submission waits
  with the failure and next attempt time; its durable episode backs off for at
  most 15 minutes, then asks for operator attention with the attempts described.
  SSH waits do not ask for key inspection before that deadline. GitHub failures
  share a remote backoff deadline; task wakes remain independent. A restart
  re-arms a pending deadline when the task or operation is observed. A successful
  retry of the failed resolution operation closes its episode even if the task
  stays in the same phase; a skipped pass or another operation does not.
- Nucleus serializes its own canonical-checkout fast-forwards. Git lock files
  do not identify their owner: another Nucleus or Paseo Git process may hold
  one. Nucleus waits and never removes the lock. A merged task retains its
  integration turn while synchronization waits.
- A failed write can have an unknown result. Classification does not authorize
  repeating it: merge intent follows exact-head reconciliation, and review
  publication observes its persisted marker before every possible new post.
  A transient review POST failure keeps the existing 15-minute backoff: absent
  markers permit another POST, while found markers bind the earliest exact-head
  review. Exhaustion parks with the elapsed bound and attempt count; permanent
  failures keep their recovery route. Workers wait through forge failures in
  pushes and PR creation, observing the remote before retrying. A blocked worker
  report with its own transient forge evidence resumes that retained worker
  within the same bound. Self-force uses `nucleus task -` with the run credential,
  never `nucleus_report`; it cannot discard an unpublished verdict.
  Other unknown writes keep their existing recovery path. The external-merge
  sweep advances a positively merged PR only at its recorded head and after its
  participant and effect leases are settled.
- Every outbound Paseo call passes through admission classes with concurrency
  bounds, identity coalescing and a short cache of quiet observations. A latency
  breaker defers new workspace creation and nonessential mutation, and the
  workspace budget equals the global task-slot limit.
- Every external effect (workspace, agent, message, comment, review, merge,
  archive, hook) records intent before acting and keeps an uncertain state.
  Unknown delivery is observed and reconciled before any retry; an unknown
  outcome never repeats the effect except the explicitly ruled terminal thread
  archive recovery described under [Cleanup](#terminal-workspace-cleanup).
- Archive and removal failure never holds task advancement; reviewer and
  coordinator archives and every closeout removal have durable intent, observed
  result and uncertain state.

## Cleanup

### Terminal workspace cleanup

- A terminal transition schedules run-output settlement on its task lane and
  then queues workspace cleanup directly. A held archive retries at its recorded
  deadline, with bounded task follow-ups and the sweep as recovery after restart.
- The cleanup lane admits at most four tasks at once. Entries for the same task,
  including workspace retries, run one at a time; a pause stops new starts.
  Projection waits return while paused, leaving queued entries for unpause or
  reconstruction from durable task state after restart. Each occurrence retains
  its own projection accounting and durable retry state.
- Up to two terminal thread pipelines overlap under shared Paseo admission.
  A lost archive answer is observed first. A terminal task can reissue for the
  same idle, owned thread only after fresh identity, workspace and complete
  owned-tool proof; three durable retries use backoff, then leave a visible
  wait. A breaker deferral that reached no Paseo call is a wait, not
  uncertainty: it records one `thread_archive_wait` per distinct reason, keeps
  the intent retryable, and the thread archives on the first admitted pass. The
  existing workspace `retry_effect` rearms those attempts and repeats
  the same proofs (planner ruling, 2026-11-04). A terminal title follows the
  phase. A bare prior-process intent without a recorded transport-loss result
  stays observation-only. Planner ruling `dc9c70718c10e5f576ce2e041092c67eb8fa0194ea35ba2f278c8007a24122d0`:
  "Treat it as observe-then-reissue, not a blind replay. Archiving is an
  idempotent move to a target state on a terminal task's own thread, so the
  side effect that matters is 'this thread ends up archived'." The ruling
  requires the same identity and workspace, idle or closed state, no active
  turn, permission or live owned tools, and at most three durable retries.

- T3 task threads stay settled while the task is open; none is archived or
  deleted, including a reviewer or coordinator displaced by replacement or a
  profile change. Retained reviewers and recovery threads are continued for the
  next round or fault, unless gone, deleted or assigned a different profile
  (Tom, 2026-11-12; [T3 thread lifecycle](../specs/t3code-host-adapter.md#thread-lifecycle)).
- At closeout after a merge, completed proof or completed cancellation, the
  existing terminal thread lane archives T3 worker threads and deletes the
  task's reviewer, recovery, coordinator and executor threads. Their runs are
  released and their verdicts, reports and decisions already live in Nucleus's
  records and on the PR; decider threads keep their existing lifecycle.
- T3 role detection uses the shared label keys. A stored role label identifies
  support; the task's worker identity or revision-run history identifies workers
  without a role label (planner ruling, 2026-11-12).
- Deletion records intent before delivery and confirms `deletedAt` or absence
  from a complete inventory, including after the final attempt; an archived
  support thread still owes deletion. Unknown deletion delivery is never resent,
  and only a proven pre-delivery failure remains retryable through the terminal
  lane; cleanup failure never blocks task closeout.
- The sweep directly queries already-finished T3 tasks with outstanding thread
  cleanup, rather than using the active-capacity index. A bounded rotating window
  schedules those tasks on their existing task lanes, so a slow cleanup cannot
  hold the host sweep and permanently pending candidates cannot starve later tasks.
- The common terminal thread lane records completion per task after every thread
  effect is confirmed, for ordinary closeout and catch-up alike. A task cleaned
  before the catch-up query therefore still has its completion record, and later
  sweeps do nothing once cleanup is confirmed.
- Paseo keeps its existing archive behaviour for released support threads,
  reviewer replacement and terminal cleanup.
- A done task's workspace is archived with every thread in it (Tom, 2026-09-27);
  only a running thread (active turn or pending permission) makes it wait. No
  unreleased task run may remain. Uncommitted files, unexpected or unpublished
  commits and changed Git ownership preserve it.
- A finished task's active recovery episode does not outlive its runs. Once no
  recovery run is unreleased, the terminal cleanup pass closes the episode:
  `recoveryActive` clears, the episode and its incident resolve, the stop that
  described it clears, and `recovery_episode_settled` is recorded. A pending
  accepted report is recorded as not applied. A live or unobservable unreleased
  recovery run still holds the episode and the archive (Queue #670, #680). The
  settlement runs before the archive's terminal gates, so a cancelled task (which
  the lifecycle sweep visits while its episode is stale) and a done task without
  a recorded merge both close it. A done task's merge guard still refuses its
  archive; a cancelled task's archive stays with its disposition. A recovery run
  that the sweep releases as observably idle, or that had recorded an escalation,
  settles its episode, incident and stop the same way: the release clears
  `recoveryActive` first, so the settlement reads the run it released.
- An external merge observed during a recovery episode settles that episode the
  same way, in the merge's own write, so a merged task reaches closeout with
  `recoveryActive` clear. The merge supersedes every run it finds; a re-entry for
  an already-recorded merge does not touch a live episode.
- Archive only Nucleus-owned, idle, clean workspaces with proven identity and the
  exact head published; adopted and externally owned workspaces are preserved.
  If merge deleted the branch, the recorded merge commit proves publication.
- Before archive Nucleus resolves each package's Cargo `target_directory` (via
  Cargo metadata, honouring config and environment) and each `node_modules`
  root, rejects intermediate symlinks and removes the roots only after proving a
  clean worktree, published head, exact ownership and idle threads. Metadata
  failure, an outside target or an unsafe root blocks completion with its path
  and reason.
- An untracked symlink at a discovered root does not block cleanup (Tom,
  2026-10-19): Nucleus proves it with lstat and leaves the link for checkout
  removal, never touching the target. Tracked files or links under a root, a
  redirected parent or a changed observation stay unsafe. `complete` means only
  Nucleus's own cleanup obligation for that root is met.
- An unfinished, skipped or uncertain cleanup stays visible on the board and is
  protected from history retention. Cancelled tasks archive only under
  `archive_if_empty` after the pushed-head proof
  ([Spec 003](../specs/003-post-dispatch-task-disposition.md)).
- A workspace removed outside Nucleus (catalog-absent, directory gone) is
  recorded archived, and its pending `task.pre_archive` occurrences stop being
  effects.
- Terminal cleanup archives every thread Nucleus created for a merged task, and
  the consumer's `task.pre_archive` retention gate runs over the exact checkout.
- An owner may later retire a completed cancelled task's preserved workspace
  with `retry_effect workspace_archive.<id>`; the authorization, intent and
  result live in `resolution.workspaceRetirement`. It proves clean published
  source, ownership, closed PR truth, idle participants and released runs;
  dispatch holds and retention gates fence it.
- A stored reviewer run binds its own workspace, so a pinned-view reviewer
  doesn't fence cleanup of the task workspace. Cancelled tasks with pending
  cleanup stay in the lifecycle scan after restart.
- Unavailable producer history is a cleanup blocker, never evidence of idle
  tools (Tom, 2026-10-18).

### Run-bound build output

- An authenticated author, revision or reviewer result writes a run-bound
  cleanup record. It settles when the run is released, its agent is idle with no
  turn, permission, owned tool or blocking effect, no other run in the workspace
  is unreleased, no host run holds the checkout
  ([Spec 035](../specs/035-host-run-scheduler.md) "Workspace custody") and the
  checkout shares the repository's common directory. Terminal archive waits on
  the same host-run hold.
- Installed: run-bound settlement removes only Cargo `target`; `node_modules`
  stays and is reported retained, and only terminal cleanup removes it (Tom,
  2026-10-20). Approved, not yet built: Cargo build-output deletion leaves
  Nucleus (R8, [vision](../vision.md#simplification-rulings-2026-10-31)).
- Settlement runs in the task's serial lane before the next run launches. A
  held settlement retries; a skipped (unsafe) root does not. Runs before this
  rule have no record. Adopted and preserved workspaces get none.
- Continuation prompts, `next` and task detail quote the recorded cleanup
  records with their workspace and run, stating removal, retention, skips and
  missing records as such. This is visibility only.
- A run-bound intent may settle after a later revision genuinely superseded the
  author, given that revision's receipt and applied completion plus terminal
  evidence.

### Runtime retirement

- Paseo's `worktree.teardown` runs `effigy container retire --yes`. Nucleus
  captures the runtime scope token before archive and afterwards proves
  retirement with `effigy container retire --scope <token> --yes` (exit 0 means
  nothing owned remains). A failed proof, teardown failure or surviving
  directory flags "runtime retirement failed"; `retry_effect` retries with the
  same token.
- A retained canonical Nucleus-owned worktree that Paseo uncatalogued finishes
  with non-force `git worktree remove` after fresh proofs. Cleanup is complete
  only when the directory is gone and retirement is proved.

### Workspace archive retry

- Each failed archive keeps a durable attempt count, cause and deadline per
  workspace: one minute, doubling, capped at one hour. Nucleus observes an
  uncertain archive before reissuing, and does nothing before the deadline. One
  workspace's failure never blocks another's.
- A pass inside the deadline runs no archive proof and none of the terminal
  work (`task.finished` evaluation, manifest read, host-process sweep) unless an
  archive is due or a durable `finishedHook`/`hostProcessSweep` intent is still
  owed. A settled manifest discovery per checkout and commit is cached.
- `next` lists a done task's failed or unconfirmed archive as
  `workspace_archive.<id>`. Owner `retry_effect` bypasses only that deadline,
  waits for its own cleanup occurrence and re-proves custody, ownership, source,
  publication, idleness, retention and build-output state.
- While paused, the retry runs nothing, refuses naming the pause and reports
  the stored failure as history; a validly recorded discard stays durable.
- An outstanding archive intent is observation, not authority: it owes one
  catalog observation per retry interval, and before any further removal
  obsolescence (for a view) or ownership is re-derived. An automatic pass never
  re-sends an unknown request; the owner's `retry_effect` re-runs the same
  idempotent request after observing.
- Archive intent is persisted at the adapter's final permission callback;
  catalog absence with a retained checkout enters guarded local teardown, and
  catalog plus directory absence settles it. A failed observation permits no
  replay.
- The thread inventory follows every page (200 at a time) and narrows to the
  workspace's `prj_` project id only when the first pass read it; a
  contradiction scans daemon-wide for the rest of the attempt. A missing cursor
  or missing known participant refuses as incomplete.

### Pinned review views

- No run gets a pinned review view. `reviewSourceView` is history: stored rows
  still parse, and no review, delivery, callback or restart reads it.
- A done task's unarchived stored view still goes through the terminal archive,
  with its identity, cleanliness and publication proofs, and holds that task's
  retention until it settles. Each view keeps its own bounded retry and
  `retry_effect workspace_archive.<id>` exit. A view on a retired volume needs the
  owner discard; on an active volume with a retired source it stays preserved.
- One `archiveIntentWorkspaceId` exists per task, so at most one native request
  is in flight. An intent no reviewer run names, which a lost task-removal reply
  can leave on a nonterminal task, is observed once per retry interval, reported
  with its catalog answer and never re-sent.
- Nucleus binds the exact existing catalog registration for a folder and never
  adds a second one; it never merges, reparents or deletes another owner's
  registration.

### Owner content discard

- `retry_effect workspace_archive.<id>` on a done or completed cancelled task
  accepts `discard: true` with a `reason` and owner authority (the operator at
  the board, or a relay with `relayed: true` and the operator's
  `note`). Nucleus records one durable decision bound to the task, workspace and
  directory (`workspace_discard_authorized`); prose is never content-loss
  authority.
- A discard waives only the content proofs (clean head, porcelain,
  publication). Every identity, custody, fence, participant, retention, runtime
  and unknown-delivery check stays.
- Under a discard, removal re-proves the owned path with no symlink redirect.
  A worktree Git knows is removed with `git worktree remove --force`; an orphan
  only when its `.git` names the absent worktree record and `git worktree list`
  omits it.
- Under a discard only, removal first gives the owner write and search on
  directories inside the owned root, through BSD `find -P` and
  `core/workspaces/normalize-directory-helper.mjs` (Darwin only). An ordinary archive
  never changes a permission. The archive records
  `workspace_contents_discarded` and claims no clean or published source.

### Report-only donor source

- A report-only `done` task may leave commits beyond its planning base; its
  workspace archives through the same cleanup when the checkout contains every
  authenticated head the task recorded, is clean in the registered worktree and
  is published (see [published source](#published-source)).
- Origin is re-read on every pass and must stay the recorded repository URL.
  `archiveIntentHead` pins the head; an uncertain retry reuses it.
- The source head is archive evidence only, and the remote branch is never
  touched. Owner `complete` already decided the disposition.

### Published source

- Terminal archive, including a stored pinned view, cancellation archive and owner
  retirement share one publication proof. The clean HEAD is published when the
  origin task branch contains it, a done task's merge commit is on the pushed
  integration branch, or any branch origin advertises contains it.
- Nucleus fetches first and reads live heads with `ls-remote` last, counting a
  tracking ref only while it equals its live head. A deleted, stale, foreign or
  prefix-matched ref proves nothing. The recorded hosted repository must still
  be the origin URL, and every pass must select the same branch.
- The proof never pushes, creates or deletes a branch and grants no review,
  merge or PR credit.

### Terminal participant liveness

- A fresh native `closed` observation for the same participant and workspace,
  with no turn or permission, ends the historical-tool requirement for cleanup
  and run-bound output. `idle` and `error` keep the complete-tool proof, except
  on a merged task, whose idle or errored participants owe no tool history (Tom,
  2026-10-19).
- Missing, failed or contradictory observations refuse; an archived flag or
  unavailable timeline proves nothing. Closure supplies no result or credit, and
  uncertain effects still hold.
- Closed is managed-session liveness (Paseo publishes it after session closure),
  not proof that every detached resource is gone; host process sweeps, runtime
  retirement and retention still apply.

### Owned-tool evidence

- The shared stopped-run and cleanup reader proves coverage through widening
  tail reads: 200 entries, then doubling, at most six reads with a 10-second
  deadline each, retaining every earlier entry as the suffix.
- The same reader answers the waiting question: `runningOwnedTool` returns the
  oldest call whose latest state is still `running` and whose kind can outlive
  its turn, and `ownedJobWait` turns that into the task's visible wait. It never
  settles anything; a turn-bound kind, a terminal or unrecognised status,
  ambiguous simultaneous states or an unreadable page returns no job.
- Every response needs coverage flags, an epoch and matching cursors. Gaps,
  resets, missing facts, read failures and exhausted budgets refuse. Partial
  history needs turn IDs and a dated boundary into an earlier turn; a partial
  tail never hides a live or unknown tool.
- Merge, external-merge, closeout, superseded-run, cleanup and author
  capability-upgrade gates read this proof. In fixtures
  `observedParticipantTimeline` in `test/support/tool-timeline.ts` supplies
  complete empty history only for participants the fixture observes.
- A call is live by its own turn, not by its label. When the same agent's own
  fresh observation proves no turn is live — `active: false`, the positively
  reported `activeTurnId: null`, no pending permission and a finished-session
  status — a running call of a kind that cannot outlive its turn is settled: a
  provider sub-agent call that a completed turn left running owns no effect once
  that turn is over (effigy#524). Every one of those facts is read positively, so
  an observation that omits one settles nothing. A shell command or a worktree
  setup — the processes a turn detaches, the background shells and terminals
  that genuinely outlive it — keeps the fence, as does an unknown or missing
  kind without process proof, a status-less or ambiguous entry,
  and conflicting identity unless the turn is over and the latest state is terminal
  or every observed kind is turn-bound. An explicit process-owning kind takes
  precedence over a turn-bound tool name. Unreadable observations and partial
  history also hold. A fresh clear observation settles the recorded owned-tool
  hold for each run bound to that participant. Any non-turn-bound tool left
  running after a positively finished turn (including an unknown-kind edit)
  settles only when the host process listing uniquely finds that run's
  `mcp-report.mjs` ticket helper, identifies its parent provider process, and
  proves that process has no descendant except the Nucleus helper (or its own
  descendants) and — once that same fresh observation proves no turn is live —
  the provider's own standing tool runtimes, which outlive every turn by design
  (Queue #683). Those runtimes take two facts from the listing, never a provider
  name list: the program is one the provider ships (inside an application bundle
  such as `Foo.app/Contents/…`, or beside the provider's own executable under
  its own program name, `codex-code-mode-host` beside `codex`), and its own shape
  is a tool server, not a command (a runtime host such as `node_repl` or
  `*-host`, the provider executable in its `app-server` mode, or an interpreter
  started directly by one of those hosts that carries the whole session binding
  it was started with — `--session-id` with a uuid or token-length hex id and a
  `--working-dir` — and that shares its host and directory with another runtime
  script, so a command cannot join the set by copying arguments; such a runtime
  claims its script's directory, and the runtime scripts there (its warm
  `kernel.js` and the trusted worker) are the same family — but only while that
  host started them: a script a runtime starts, even from the runtime's own
  scratch directory, is a command). Shipping location alone never exempts a
  process: a shell, a generic host program from the same install directory, a
  bundled application the agent launched, a bundled interpreter running a
  workspace script, and a script in the agent's own temporary directory are all
  commands. Those runtimes' own children are judged one
  by one, so a command a kernel spawned is still real work and still holds. A
  live descendant keeps the hold and names its PID; a missing
  helper, ambiguous match or unreadable process listing keeps the hold as
  unknown. The evidence is recorded on the task. `next` exposes the hold as
  `owned_tool.<runId>` and `retry_effect` rechecks the same process tree. The
  turn proof is read after the evidence it settles, so a turn that started
  during pagination still holds. Nucleus never reads provider files to settle a
  call.
- A participant's non-turn-bound tool keeps a pre-merge lease only for the
  configured `graceMs` after its first durable hold. Once that grace expires,
  Nucleus rechecks that the same participant is idle in the same workspace,
  then uses the host-process reap path and records the stopped processes on the
  task. While the participant wait is open, the task yields its repository
  integration turn; after the wait clears it rejoins through the existing FIFO
  turn mechanism. A live or changed participant is never reaped, and an
  uncertain merge intent continues to retain its turn.

### History retention

- A daily pass while unpaused purges each task whose history has passed the
  4-day expiry window (Tom, 2026-10-20; see [Closeout and
  outcomes](#closeout-and-outcomes)), deleting its events, runs, receipts,
  notices and hook records. These defer the purge: unreleased runs; a
  pending archive intent or a merge without a recorded commit; an unfinished
  build-output cleanup, workspace retirement or runtime retirement; an
  external workspace archive in `intent` or `uncertain`; a done task's
  workspace, closeout workspace or review-source view not yet archived; a
  notice in `pending`, `intent` or `uncertain`; unsettled hook custody; and
  an origin that never resolved. Pausing pauses retention.
  A task whose hook retention is not settled keeps its whole history: hook
  records carry the only proof of an isolated checkout's ownership.
- A purge leaves a tombstone naming the task identity, submission identity,
  input hash, task reference and whether the goal was met, so dependencies
  still resolve (a purged prerequisite never satisfies a dependent and reads
  as "history purged") and a repeated submission returns the retained record
  instead of launching the work again. Outcome rows are permanent and never
  purged ([Spec 025](../specs/025-outcome-query.md)); usage samples are
  pruned separately at 14 days ([Spec 059](../specs/059-usage-gauge.md)).

## Test infrastructure

Client render tests share `test/support/board-shell.ts` for source and bundled
renders. The render harness binds source imports; its `boardShellPlugin` routes
bundled shell imports to the same host hooks and native stand-ins.

- `project.qa.run` accepts `wait: true` (CLI `--wait`) to return the settled
  admitted run, including state, exit code, failure indexes and a retained
  consolidated failures log path, null when there are no diagnostics. Waiting
  does not change the durable request identity or its admission. Explicit
  settlement calls keep their connection until an answer or transport loss;
  unknown delivery still reconciles through the existing request and operation
  reads without blind replay.
- A settled milestone QA run sends an idempotent agent-channel message to the
  registered project planner and, when available, the submitting agent. It
  reports state, failed and cancelled counts, and run ID. Non-TAP failures may
  have no test identities; the failed step's retained output path is the
  diagnostic pointer. The recorded QA timeout is the scheduler envelope; each
  step uses its configured timeout, and staged envelopes include all stage
  limits plus setup and teardown limits. An explicit QA limit wins over a
  historical wall-time estimate, which never lengthens the enforced limit.
  Staged notices name each stage's failed and cancelled counts; the timing
  stage may be inconclusive under host saturation only when every failure is a
  measured wall-clock or CPU assertion marked with `performanceAssert` in
  `test/support/timing.ts`. Functional failures, cancellations, runner faults and
  missing classification evidence fail the lane regardless of load. A passed
  notice with inconclusive timing names the failed performance oracles and says
  "timing inconclusive under load: N performance oracles failed"; TAP TODO
  failures are not counted as failures.

- The affected-test selection (`scripts/test-affected.mjs`, `effigy test:affected`)
  reads the committed head only: changed paths come from `git diff --no-renames`
  against the merge base, and the graph from one `git ls-tree` plus one
  `git cat-file --batch` read. Import edges reuse `importEdges` from
  `scripts/check-folder-imports.mjs`. A test is selected when it transitively
  imports a changed file (through `.js`/`.mjs` emitted specifiers, index files and
  `.d.mts` declarations of their implementation), when it names a changed path or a
  path suffix of two or more segments as a string literal in its own source or in
  the `test/` helpers it reaches, or when it quotes any ancestor directory of the
  changed file as a whole literal (directory walkers recurse, so `client/` covers
  `client/board/x.tsx`). A changed test file always
  runs. Paths outside the graph and the docs (`package.json`, `effigy.toml`,
  `tsconfig*.json`) are reported as unmapped, never expanded to a full suite.
- Test races are fixed as a class (Tom, 2026-10-15): a milestone failure that
  passes alone is attributed to its race shape, and one task covers every test
  with that shape. A failed physical file is investigated alone before any
  correction.
- Fixture Git mutation, disposal and server stop after `quiesce`/`wake`/`stop`
  are safe. A synthetic task workspace that can reach dispatch lives inside its
  fixture's own root, never directly in the host temporary directory.
- The parallel unit runner orders files by the recorded per-file durations in
  `scripts/test-durations.json`, longest first; unmeasured files follow in
  alphabetical order. Explicit file selections retain their given order. Refresh
  the measurements after milestone QA when the suite shape changes. Fixture
  populations prove the asserted branches with the smallest useful data;
  real wall-clock comparisons run in the serial timing lane.
- Both test lanes preload a fresh `NUCLEUS_DATA_HOME` for each physical test
  worker under its run's `TMPDIR`, before product imports. Ambient work-root and
  volume-pin overrides are cleared. A test may select its own fixture data home;
  helper and production subprocesses keep their explicitly supplied settings.
- Bridge readiness polling and its clock are injectable for fixtures. Production
  uses its normal polling interval and wall clock; claim ownership and freshness
  rules are unchanged.
- The 120-second unit budget is per physical file. A family whose real
  fixtures exceed it splits by measured per-case cost through
  `test/support/sharded-test.ts`, aiming at about 60 seconds per shard and
  recalibrating against the slowest observed host state. A family never moves
  to the timing lane to escape the budget.
  The retained-review lifecycle family keeps its stateful sequences in one case
  source and registers them through one physical test file. Independent author-evidence
  refusal fixtures have separate registrations; the machine-checked scenario,
  body and loop inventory is retained in Git history at
  `evidence/retained-review-layout-20261101`.
- Store schema-floor refusal is covered in `test/store-schema-floor.test.ts`;
  feature tests cover their current data and restart behavior. Fixture process
  teardown uses recorded spawn identity and process groups; command-line shape
  is never ownership evidence.
- A fixture binding a Unix socket creates its root through
  `test/support/socket-fixture.ts` and checks `assertSocketPathFits` (macOS
  `sun_path` is 104 bytes).
- Fixtures answer RPCs with the method's real shape, and bundled UI fixtures
  wait for the visible result rather than a fixed tick count. The render harness
  subscribes an external store once per `subscribe` identity.
- Plain test profiles, adapters, submissions and temporary stores use
  `test/support/fakes.ts`; scenario-specific behavior stays in overrides.
  Fake adapters leave optional capabilities absent unless supplied by the test.
  Git-heavy families use `test/support/git-seed.ts` for repeated setup, with
  independent copy-on-write repositories and real Git for behavior assertions.
- Worker readiness uses read-only preflight and disposable lifecycle proof;
  runtime acceptance after review, merge and roll follows the
  [working rules](working-rules.md).

A retired-volume workspace remains owner-held until `retry_effect` on its `workspace_archive` effect records an explicit discard. Queue preserves task identity, custody and idle-participant checks, asks Paseo for a guarded catalog-only archive, and removes only the exact matching Git administrative worktree record. Unreachable contents are not described as clean or published. A dispatch hold remains recorded but does not prevent this owner-authorized retired-volume archive. Paseo refusal remains a held effect; no automatic retired-volume archive retry runs.

For an externally owned workspace on a retired volume, Queue settles its catalog effect without sending an archive or probing the folder (planner ruling, 2026-11-05). The Paseo entry may remain visible and needs a Paseo-side route; the record does not claim that the entry or folder was removed.

Report callback receipts retain both the submitted report digest and the completion
receipt. An unfinished report intent survives restart; a repeated completed report
returns its stored response. Thread archive effects use host-qualified agent keys.
Retention removes those keys when no retained task or run refers to the agent.
Schema 53 migrates legacy archive and report metadata behind the store backup.

Admission reads active capacity facts and bounded ready queue heads. It does not
maintain a separate full-capacity task index.

Reviewer input receipts accept individual file hashes or bounded directory, glob,
and counted digest summaries. For a digest, hash the UTF-8 JSON array of
`{path, sha256}` entries sorted by path. These receipts do not replace the
exact-head review gate.

Forge pending-check timers are scoped to repository, PR head and check name;
terminal status contexts clear their timer. Strict branch-rule reads use the same
unknown-on-error interpretation as required-check discovery. Paginated forge
inventories have a finite 32 MiB response budget and fail closed when exceeded.


## Shared task decisions

Ready review at head is derived by `readyReviewAtHead` in `core/recovery/task-reasons.ts`:
a ready verdict must name the exact nonempty PR head. Owner source acceptance
remains a separate route and does not manufacture a review verdict.

Owner views and handlers share never-dispatched, live-role and resume decisions
and refusal sources. A run with a completion is reported history even before release,
so routing and the active-run view do not treat it as live. Store owns retention eligibility, active-capacity membership,
and credential, receipt and availability writes; callers retain their transaction
boundaries and callback authentication checks.

Retention candidates feed hook cleanup. Purge rechecks the same history eligibility
and additionally waits for that cleanup to settle before removing hook ownership evidence.


Shared refusal helpers keep each applying handler's precedence across views and
offline admission. Move-to-review checks terminal/merge state before disposition;
work and merge check disposition first. Stop can still release an integration
turn after termination or disposition, and can park an unstarted task just as its
handler permits. Retained-reader and proof previews use the applying refusal text.

### Shared service primitives

`core/git/git-command.ts` owns asynchronous Git execution, byte-exact output,
fetch serialization and SSH authentication retries. Commands default to a
30-second timeout; declared slow Git operations keep their explicit timeout.
The raw result retains exhausted SSH authentication failures so the command
boundary can distinguish a forge outage from a healthy-host refusal.
`core/machine/owned-file.mjs` owns owner-only atomic file and JSON publication, and
`core/machine/pid.ts` owns PID liveness probes.

Hook renewal keeps each event's eligibility proof, then shares publication
absence proof, checkout cleanup, supersession and replacement execution.
Cancellation and blocked occurrences may renew after a definitively rejected
push when absence from the remote is proved and the old checkout is clean at
its pinned base; unpublished dirty content still needs explicit discard.
A retained workspace whose head cannot be read holds pre-archive.
Hook observations retain at most 2,048 entries per map, and checkout cleanup
reads occurrence payloads in bounded pages through a fixed rowid watermark rather
than retaining the full table. Backup subprocesses have a two-minute timeout.
