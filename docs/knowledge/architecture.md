# System architecture

Status: active

Each entry names a file, what it owns and where the rules live. Read the
[orchestration contract](contracts/orchestration.md) before changing state
transitions or external effects. The
[daemon owners](contracts/orchestration.md#daemon-owners) section maps each
owner to the rules it enforces.

## Modules

### Entries and shared contracts

- `index.client.tsx` and `index.server.ts` are the two Paseo 0.8 contribution
  entries, each a thin re-export of its process index in `hosts/paseo/`.
  `hosts/paseo/plugin/index.ts` is forwarding-only: it registers every method in
  `shared/rpc-catalogue.ts` and forwards to the local service.
- `shared/contracts.ts` exposes validated RPC and task/run shapes, with task
  primitives and compact view schemas in `shared/schema/`. Pure task reads live
  in `shared/holds.ts`, `shared/disposition.ts` and `shared/task-view.ts`
  ([shared task reads](contracts/orchestration.md#shared-task-reads));
  `shared/hooks.ts` the hook manifests, events, results and durable hook
  records; `shared/operations.ts`
  the durable operation record and acceptance envelopes
  ([Spec 012](specs/012-durable-asynchronous-operations.md)).

### Client

- `client/queue.tsx` is the board shell: tabs, project scope, the open task or
  record, and the Planning and QA tabs. The Pipeline view (Triage, Attention,
  Queued, Working, Review and Closing) is one set of columns; cards carry no
  action buttons and finished work leaves the board
  ([Spec 019](specs/019-lanes.md), [Spec 026](specs/026-planning-records.md)).
- The board is split into modules queue.tsx imports, never the reverse:
  `client/board/` holds card text helpers (`text.ts`), badges (`badges.tsx`),
  the memoised cards (`cards.tsx`), the header with its queue menu and slot
  popover state (`header.tsx`), the Pipeline and its column widths (`pipeline.tsx`,
  columns memoised per input; its Triage filter, pages and measurements sit in
  `usePipelineState`, which the shell holds so they survive tab switches), and the
  board reads (`use-board-data.ts`: task detail and next, the planning lists on
  their per-domain revisions, planning, QA, and the shared `act`/`leadAct`);
  `client/task/` holds the task
  dialog (`task-dialog.tsx`: frame, header, tabs) and one file per tab
  (`overview.tsx`, `technical.tsx`, `runs.tsx`, `activity.tsx` with Messages),
  plus task-detail parts (`parts.tsx`) and the owner-verb `NextSection`
  (`next-section.tsx`); `client/records/` holds the lead, papercut and
  decision dialogs and their shared `RecordModal` (`record-modal.tsx`). Record
  dialogs own their form state; task tabs keep theirs in a board-held ref
  store (`drafts.ts`) so drafts survive tab switches as before. Typing in
  either, or opening a header menu, does not re-render the board.
  `client/telemetry-parts.tsx` holds timing and validation sections shared
  with the Settings telemetry screen; `client/use-tick.ts` is the shared
  re-render timer. queue.tsx re-exports the names it used to export. Source
  assertions read `test/support/board-source.ts`, which concatenates
  queue.tsx and the split modules, so a pure move keeps them green.
- `client/focus-modality.ts` tracks keyboard or pointer modality for the focus
  ring. Every control keeps the tracker listening; only the focused control
  subscribes, so a key or pointer press re-renders that control alone.
- `shared/pipeline-board.ts` sorts in-scope cards into the board's columns, each
  card once. Papercut decision links resolve through the lead projection, since
  papercuts are tagged leads. `core/telemetry/ui-snapshot.ts` caches the compact board projection by
  store revision; terminal history is read only by detail and telemetry.
- Board components reach the host only through `client/shell/` (data calls,
  the workspace, icons, navigation, composer pills, agent inventory).
  `hosts/paseo/client/shell.tsx` is the one Paseo binding, with `index.client.tsx`
  the thin root entry forwarding to the host client index;
  `test/shell-boundary.test.ts` enforces it. A web shell binds the same
  interface at `client/shell/index.ts` (vision, "The UI for other hosts").
- Every popover (help tips, dropdown menus, button and card status
  tips) renders through `client/popover.tsx` into one overlay layer, a
  `PopoverHost` at the root of the Settings screen and of the board, positioned
  from its anchor's window coordinates. A popover inside its own card is painted
  over by later cards, and zIndex cannot leave the card (Tom, 2026-11-08).
- Record dialogs use the shared `Dialog` frame and its `PopoverHost`; controls share
  the disclosure, button and text-link primitives. Client error text and timed
  refreshes use shared helpers.
- Common actions are one icon-only `ActionButton` (`client/controls.tsx`)
  with the same icon everywhere: add, remove, duplicate, edit, refresh, close,
  move into, pause and resume, make primary. Its accessible label and tooltip
  name the action and its object ("Add profile"). Text stays where an icon
  would be ambiguous or the action is the surface's main act: Back, Retry, a
  dialog's danger confirm, Keep and Cancel, On/Off toggles, task holds, routing
  and QA runs (Tom, 2026-11-09, nucleus#999). List actions sit at the right of
  the section heading; item actions at the top right of the opened card.

### Runtime and store

- `service/runtime-owner.ts` owns the process lease, store, daemon adapter,
  callbacks, pre-insertion policy validation and reconciliation, with bounded
  construct, start, health and drain phases so an unreachable Paseo SDK never
  blocks lease release. Startup diagnostics follow the
  [service boundary](contracts/service-boundary.md). A lost plugin presence
  while a host is still connected raises the board error and messages the
  Nucleus planner once.
- `core/store/store-compaction.ts` owns the one-shot store conversion, run once at
  start before serving ([store compaction](operations/store-compaction.md)).
- `core/store/` gives each store mechanism one owner. `store.ts` is the facade:
  owner wiring, the transaction and listener boundaries and the shared read
  clocks. `store-tasks.ts` owns the task projection and the task read models
  (`taskIdsForIdentities` maps a bridge lifecycle hint to Nucleus identities
  without reading fleet history), `store-queue-index.ts` and
  `store-board-index.ts` own the dispatch and board indexes over that
  projection, and `store-task-funnel.ts` is the single writer of task and run
  rows. Opening and migrating a store is `store-admission.ts`, the every-open
  row strips are `store-migration.ts`, the retention windows are
  `store-retention.ts`, and the file facts, content fingerprint and freed-page
  reclamation are `store-reclaim.ts`; `store-schema.ts` holds every schema
  statement. Task events, authenticated receipts, role runs, notifications,
  availability and operations keep their own store modules.
- `core/telemetry/telemetry.ts` derives lifecycle timing and interventions from durable
  facts; `shared/telemetry.ts` owns its schemas. `queue.detail` and
  `queue.telemetry` read them; no analytics database exists
  ([durable telemetry](contracts/durable-telemetry.md),
  [Spec 005](specs/005-queue-telemetry.md)).

### Lifecycle

- `core/engine.ts` is the daemon shell: it constructs the owners, stops them,
  holds the profile catalogue and supplies live ports to phase owners. Task
  quanta (`taskQuantum`, `quantumSteps`, `quantumFinish`) live in
  `core/scheduling/task-quantum.ts`; stop classification and retention hooks live
  in recovery and hooks. Same-name delegates keep instance overrides live.
  Durable rules live in
  [daemon owners](contracts/orchestration.md#daemon-owners).
- `core/verbs/owner-verbs.ts` owns the owner verb registry, `task.next` and
  `currentReviewOutcome` ([Spec 050](specs/050-owner-task-controls.md)).
- `core/dispatch/routing.ts` applies eligibility gates, keeps every profile that meets
  demand, then rotates by weight times the cost lean and balances by group
  ([Spec 053](specs/053-demand-based-selection.md)). Its `RoleSelection` decides
  who may take a reviewer, coordinator or executor role; `Resolution` delegates
  to it. `reviewerIndependence` is the pure Spec 036/050 rule those sites share,
  each with its own unknown and waiver shape. The file imports no server module
  by value, because `store.ts` imports it.
- `core/workspaces/checkout-siblings.ts` fast-forwards clean sibling checkouts;
  `core/store/sibling-store.ts` shares their objects through one bare store per
  origin
  ([Spec 028](specs/028-fresh-sibling-checkouts.md)).
- `core/dispatch/prompts.ts` owns every prompt's text, worker included, and the shared
  rules each one repeats (validation, required proof, blocked, workspace);
  it owns reviewer, coordinator, checkpoint and continuation prompt text. Ordinary revision rounds
  carry the prior findings and delta, and proof-only rounds judge arriving evidence
  under [Spec 057](specs/057-retained-change-review.md).
- `core/resolution.ts` is the after-dispatch shell: it wraps the adapter in
  the Proxy that fires `gitTransientRecovered` and supplies live phase ports.
  `core/scheduling/lifecycle.ts` owns `owns` and ordered advancement;
  `core/dispatch/launch.ts` owns the launch funnel. Same-name delegates keep
  instance overrides live. Durable
  rules live in
  [daemon owners](contracts/orchestration.md#daemon-owners)
  ([Spec 038](specs/038-bounded-uncertain-merge-reconciliation.md),
  [Spec 007](specs/007-reviewed-head-pre-merge-hooks.md)).
- `core/recovery/task-reasons.ts` holds the reason text, refusal errors and small
  helpers the owners share. It's a leaf, so importing it never closes a cycle
  through `core/resolution.ts`. `core/dispatch/retained-work.ts` reads the retained
  author's receipted results.
- `core/machine/owned-tool.ts` proves no live tool holds a run and records the
  `owned_tool_*` events. `Resolution.ownedToolHold` delegates to it.
- `core/review/pr-adoption.ts` binds an existing PR to a task: identity only under an
  authenticated block, otherwise dead-revision recovery, initial reconciliation
  or replacement. `Resolution` keeps `recordBlockedPrIdentity` and
  `adoptReplacementPr` as delegates.
- `core/questions/delegation.ts` puts one question to one delegate under an answer window,
  on the `delegation:<id>` stream, and finds the planner, the decider profile and
  the task facts a delegate reads. `Resolution` keeps each method as a delegate.
- `core/questions/ladder.ts` holds the blocker ladder: a blocked worker gets one reviewer
  consult per cause, then one planner escalation, which a planner or decider
  settles or classifies to the operator. It also settles open escalations when an
  ordinary control moves the task. `Resolution` keeps each method as a delegate;
  `Engine` keeps `settleLadderControl`. `core/questions/blocker-ladder.ts` owns the pure
  classify/wait/continue step and the consult and escalation recovery decisions.
- `core/intake/callback-reminders.ts` sends one bounded reminder to a run that stopped
  without a result, then hands the fault to attention when its grace expires.
  `reminderDecision` is the pure rule over already-read facts.
- `core/recovery/effect-reconcile.ts` settles an unknown send from its exact message:
  reviewer deliveries, run creations and attention notices. `timelineMessage`
  classifies whether a page holds one exact user message. `Resolution` keeps
  each entry point as a delegate.
- `core/merge/check-waits.ts` polls pending required checks without the integration
  turn, handles the one same-head rerun of runnerless jobs, and reads merge-gate
  and required-check evidence against the settings revision. `Resolution` keeps a
  same-name delegate for each moved method.
- `core/merge/merge-intent.ts` verifies a durable merge intent against GitHub and spends
  its one SHA-guarded re-issue after continuous non-merge proof. `Resolution` keeps
  a same-name delegate for each moved method.
- `core/merge/merge-gates.ts` proves the exact-head merge gates: the reviewed-head and
  prospective-merge `task.pre_merge` hooks, the refusal that returns an unchanged
  head to its worker, the project validation the prospective candidate runs, and
  the mechanical gate and source checks. It then records merge intent and makes the
  one guarded merge request, re-reading the fence and settings revision before the
  intent and again before the send. `Resolution` keeps same-name delegates for
  `refusePreMerge`, `verification` and `advanceMerging`.
- `core/merge/external-merge.ts` accepts or detects a PR merged outside Nucleus: the
  operator accept verb (ordinary, review-entry and retained jobs), the automatic
  probe, and the sweep that resumes a task parked on a cleared external-merge
  check. `Resolution` keeps same-name delegates for `acceptExternalMerge`,
  `recoverExternalMerge` and `resumeClearedAttention`.
- `core/recovery/retry-routes.ts` holds where a restart sends a parked task: the
  continuation a replacement worker resumes, retry, worker resume, and the
  stopped-revision restart. `Resolution` keeps a same-name delegate for each
  public moved method, including `retry` so instance overrides still fire.
- `core/recovery/absent-restarts.ts` recreates proven-absent runs: an absent worker in
  the retained workspace, an absent resolution run, an uncertain-run restart
  under the same run ID, and the one-replacement creation budget.
  `Resolution` keeps a same-name delegate for each moved method.
- `core/intake/result-application.ts` applies a released result: reviewer, revision,
  proof-executor, and the interrupted-review reapply path. `Resolution` keeps a
  same-name delegate for each moved method. A delegate is a plain function that
  returns the owner's promise: an `async` wrapper adds microtask turns, which reorders
  detached task wakes against owner reads (route test `move to work launches the
  pending worker route`).
- `core/review/review-publication.ts` classifies the durable `reviewPublication:<run>`
  effect and holds formal publication recovery for an unpublished ordinary
  reviewer verdict. `Resolution` keeps a same-name delegate for
  `reconcileReviewPublication`.
- `core/closeout/closeout.ts` selects the closeout authority (queue, repository hook or
  agent) and finishes closeout: the queue and hook completions, the agent's closeout
  result, the sync to the integration branch, and the write that hands the turn on.
  `Resolution` keeps a same-name delegate for each moved method except the two
  private helpers, `reviewDisclosures` and `closeoutRefreshAllowed`, which only
  `Closeout` calls.
- `core/dispatch/participant-lease.ts` proves a task's participants are settled: the
  lease over identities that still own work, and the execution lease merge and
  closeout read, including retained runs and blocking recovery effects.
  `Resolution` keeps a same-name delegate for each moved method.
- `core/merge/integration-turns.ts` holds each repository's FIFO integration turn: the
  sequence assignment, the claim, who holds the turn, the closeout reservation that
  lets a landed merge pass parked verifications, and the quantum that keeps the turn
  while a task's awaited work runs. `Resolution` keeps a same-name delegate for each
  public moved method and still owns `turnReleased`, which `closeout.ts` calls when a
  closeout write frees the turn.
- `core/questions/notices.ts` holds the one durable send every notice shares, intent before
  the send and never resent blindly, and the attention, completion, hold, lane-drain
  and decision delivery loops. `Resolution` keeps a same-name delegate for each moved
  method. Its ordinary settlement is `noticeSettlement`, a pure function over the
  facts the delivery loop reads: skip, supersede, re-point, keep uncertain, wait for
  a thread, or send.
- `core/recovery/transient-resume.ts` resumes a retained run or the initial worker in the
  same thread after a transient provider error, and arms rate-limit failover when
  the resumes run out. `Resolution` keeps each method as a delegate.
- `core/questions/agent-messages.ts` sends, delivers and sweeps `tell` (alias `nucleus_message`).
  Recipients are defined once in `shared/agent-verbs.mjs`; `core/questions/agent-targets.ts`
  resolves task and project references. Its
  `AgentMessages` class holds the in-flight delivery set; `Resolution` keeps a
  same-name delegate for each moved method. `askBinding`, the run-identity rule asks and messages
  share, is a free function in `core/questions/agent-ask.ts`.
- `core/questions/agent-asks.ts` records, routes, waits on and resumes `ask` (alias `nucleus_ask`). Its
  `AgentAsks` class holds the in-flight routing set and the in-turn wait and poll
  cadence; `Resolution` keeps a same-name delegate for each moved method.
- `core/questions/questions.ts` handles raised and delegated decisions, and `core/questions/native-questions.ts` handles native task-thread questions. `Resolution` retains delegates; `Questions` holds the shared in-flight state. `operatorQuestionStep` and `answeredQuestionOutcome` are the pure raise and answered-native decisions; `applyBinaryApproval` in `question-delegation.ts` is the named final reply for a binary approval.
- `core/qa/proof-autorun.ts` starts a brief-named proof at an approved head without a question: wait for re-declared inputs, skip a docs-only head, or run the existing `proof` route once per head. `Resolution.startRunnableProof` delegates to it.
- `core/recovery/observation.ts` runs one sweep of unreleased runs: it reads each pending run's agent and settles, recovers, reminds or leaves it. `Resolution.observe` and `Resolution.observationTargets` delegate to it.
- `core/scheduling/lifecycle.ts` runs the task's advance steps in order through
  `Resolution.advance`'s compatibility delegate. An await that only some passes reach sits behind a synchronous gate, so a pass with nothing to do reaches its next synchronous step without yielding. A failed pass settles by `advanceFailureDisposition`, a pure function over the error and the task's merge state: superseded by a newer attempt, a paced git transient, a wait, an environment fault, an uncertain merge response, or attention.
- `core/recovery/stall.ts` detects a stalled turn and reconciles an operator-authorized
  stop of one against a fresh observation. `stalledStopDecision` is the pure
  rule that reconciles one stop. `Resolution.reconcileStalledTurnStop`
  delegates to it.
- `core/qa/validation-evidence.ts` answers whether validation is alive in a task's
  worktree, with one host scan per pass.
- `core/recovery/provider-refusal.ts` proves a reviewer's provider refused its turn,
  then replaces the reviewer or records a finite blocker. `refusalGap` is a
  pure function over already-read store facts.
  Same-name `Resolution` methods delegate to it.
- `core/merge/merge-hold.ts` builds hold patches. Its `Holds` class prompts the
  owner of a merge hold that is the last blocker and lifts self-lifting holds.
  `Resolution` keeps `holdLastBlocker` and `reconcileHoldUntil` as delegates.
- `core/verbs/agent-controls.ts` holds the controls a task's own run reaches
  over its authenticated callback, the `*FromAgent` entries and
  `authenticateAgentControl`. Same-name `Engine` methods delegate to it.
- `core/verbs/removal.ts` removes a task from the board, retries a failed
  runtime retirement or a skipped build output cleanup, and settles the build
  output a finished run leaves. Same-name `Engine` methods delegate to it.
- `core/verbs/settings.ts` holds the owner verbs that change a task's settings
  and nothing else: lanes, routing, worker exclusions, dependencies, notes and
  holds, completion subscriptions and the task's owner. Same-name `Engine` methods
  delegate to it.
- `core/verbs/brief.ts` re-pins a committed handoff's instruction, amends a
  Nucleus-held brief and refuses brief text that still declares a stage plan.
  Same-name `Engine` methods delegate to it.
- `core/recovery/task-stops.ts` writes a task's stops, incidents and attention, and
  closes attention episodes and escalations. Same-name `Resolution` methods
  delegate to it.
- `core/dispatch/dispatch.ts` visits queued tasks, admits workspace creation and review
  entry, and owns the workspace-pressure wake. Same-name `Engine` methods delegate
  to it; engine shutdown clears its timer.
- `core/dispatch/run-launch/source.ts` prepares the source a launch dispatches from: the
  detached ordinary review's custody and worktree, the first revision worker's
  independent profile, the retained worker route, and the PR head the run is
  launched at. `revisionRunPlan` is the pure first-worker / retained-route rule.
  `Resolution.prepareLaunchSource` delegates to it.
- `core/dispatch/run-launch/thread.ts` selects the thread a launch dispatches on: the
  retained agent when it is still eligible, or a fresh one from the pool, then
  hands that selection to reserve. `executorThreadDecision` and
  `reviewerThreadDecision` are the pure keep/fresh/reselect rules over store
  facts. `Resolution.selectLaunchThread` delegates to it.
- `core/dispatch/run-launch/reserve.ts` reserves the run a launch will deliver: the
  intent row, credential, slot charge, then the post-transaction hand-off to
  deliver. `Resolution.reserveLaunchRun` delegates to it.
- `core/dispatch/run-launch/deliver.ts` delivers a reserved run: the ordinary review
  custody and checkout proofs, the guarded native send or creation, the agent
  binding, and the uncertain or refused settlement when a step throws.
  `Resolution.deliverLaunchRun` delegates to it.
- `core/scheduling/lane-scheduler.ts` runs exclusive per-key lane quanta, `quiesce` and the
  shutdown discard of queued quanta. Same-name `Engine` methods delegate to it.
- `core/scheduling/task-wakes.ts` holds what a task's quantum owes after it runs: the
  lifecycle, completion and terminal archive follow-ups, their bounded retry
  timers, the git-transient backoff and the scheduled task quantum.
  `quantumFollowUps`, `gitTransientPlan` and `stepFailureRoute` are pure
  functions over store facts. Same-name `Engine` methods delegate to its
  `TaskWakes`; `Engine.stop` calls its `stop()`.
- `core/scheduling/sweep.ts` coalesces reconciliation windows and drains and runs the audit pass. `Engine` keeps same-name delegates and test-facing state accessors.
- `core/verbs/control-context.ts` holds the hidden parameters of every verb, the
  three async-context values per engine, and `isOwnerCall`. `Engine` keeps
  same-name accessors and a delegate.
- `core/verbs/verb-fences.ts` displaces or refuses the runs an owner verb would
  disturb. `VerbFences` holds the planning, observation, cancellation, refusal
  and release methods and `ContinuationFences` holds `Resolution`'s different
  reviewer-continuation settlement. Same-name `Engine` and `Resolution` methods
  delegate to them.
- `core/recovery/fence-settlement.ts` holds the fence and run-release writes, and its
  `RunRelease` class releases the runs no report will settle: finished,
  observably idle, superseded or never launched. Same-name `Engine` methods
  delegate to it.
- `core/dispatch/capacity.ts` holds slot occupancy and fair-share order, and its
  `SlotAdmission` class says why a task has no slot now, for one dispatch pass
  or one board batch. Same-name `Resolution` methods delegate to it.
- `core/review/review-continuation.ts` holds the checkpoint and delivery rules of a
  retained reviewer, and its `ReviewContinuations` class inspects, admits and
  delivers one authorized reviewer turn. Same-name `Resolution` methods delegate
  to it.
- `core/intake/checkpoint.ts` delivers each persisted worker checkpoint continuation
  to the same retained worker at most twice. `Resolution` constructs
  `Checkpoints`.
- `core/verbs/moves.ts` holds the owner `move` verb: to work, review, merge and
  closeout, and closeout's external-merge reconciliation. `restart role=worker`
  passes its arm into `moveToWork`, inside that transaction. Same-name `Engine`
  methods delegate to it.
- `core/verbs/dispatcher.ts` is where every task control enters: the audit
  lines, the force and cap gates, the action switch, the authority proofs and the
  wrappers that wake a task after its verb. Same-name `Engine` methods delegate to
  it.
- `core/verbs/restart.ts` holds the owner `restart` verb: every run shape it
  continues or replaces, the parked step and escalation answer it falls back to,
  the stalled-turn stop and absent-run recovery. Same-name `Engine` methods
  delegate to it.
- `core/verbs/retry-effect.ts` holds the owner `retry_effect` verb, by phase:
  the replayed outcomes, the branches that answer before observed-idle settlement,
  the recovery effects and uncertain operations, then fence settlement and the
  ordinary effects. Same-name `Engine` methods delegate to it.
- `core/verbs/reviewer.ts` holds the owner verbs that keep or replace a task's
  reviewer: `continueRetainedReviewer`, `preserveRetainedReviewer` and
  `restartReview`. Same-name `Engine` methods delegate to it.
- `core/verbs/complete.ts` finishes a task that has no PR to merge: the owner
  `complete` verb. A same-name `Engine` method delegates to it.
- `core/verbs/route.ts` holds the owner `route` verb, its live-run stop and
  subscription-group refusal, and the profile checks submission and brief
  amendment share. Same-name `Engine` methods delegate to it.
- `core/verbs/force.ts` applies `force: true` on `retry_effect` and `move`:
  who may force, the settlement record and the forced move. Same-name `Engine`
  methods delegate to its `ForceVerbs`.
- `core/verbs/owner-stop.ts` holds the owner `stop` verb and the hold it places
  and yields, records owner verbs to replay once their wait clears, and continues
  an awaiting retained reviewer. Same-name `Engine` methods delegate to it.
- `core/verbs/paused-stops.ts` stops every active thread while Nucleus is
  paused and resumes each stopped thread in place once it runs again. Same-name
  `Engine` methods delegate to it.
- `core/qa/proof-activation.ts` decides proof activation refusals and checks
  recorded release-GO evidence from task facts.
- `core/verbs/proof.ts` reads those facts and activates the one author-side
  proof execution a task's brief names. The same-name `Engine` method delegates
  to it.
- `core/recovery/worker-reconcile.ts` holds the initial worker's reconcile pass, in
  steps: observe it and settle a live one, look for its branch PR, repair a split
  reporting binding, take a blocked return, then accept its recorded result.
  Same-name `Engine` methods delegate to its `WorkerReconcile`.
- `core/intake/callback-intake.ts` authenticates, validates and records one report.
  `CallbackIntake` holds Engine's source gates and the checkpoint and
  review-progress receipts; `RunCallbackIntake` holds Resolution's run
  completion (validate, proof, build output, bookkeeping, receipt), which stays
  synchronous. Same-name `Engine` and `Resolution` methods delegate to them.
  Engine's `complete`, `completeCheckpoint` and `completeReviewProgress` delegates
  return the owner's promise without an `async` wrapper.
- `core/dispatch/worker-failover.ts` holds worker failover: the sweep that replaces
  an exhausted or failed worker, and its gated decision (`decideWorkerFailover`
  names the outcome the sweep then applies). Worker replacement is dispatch's
  business — who runs the next round — so the sweep sits beside `worker-launcher.ts`.
  Its availability facts are the store's typed `availability()` rows, and
  `unavailableGroupNames` is the one pure rule over them. Same-name `Engine` methods
  delegate to its `WorkerFailover`.
- `core/recovery/retired-observation.ts` holds the retired-worker observation
  cadence and the lifecycle-signal invalidations that make an identity due early.
  `core/workspaces/retired-agent-archive.ts` archives retired errored agents so a
  Paseo workspace stops reporting Failed, and records each unreadable read and
  refused archive on the thread-archive wait lane.
- `core/planning/operations.ts` holds durable operations: accepting one, scheduling
  it on its lane, running and settling it (typed pre-send refusals settle
  definite, unexplained failures by the prose classifier), restart
  reconciliation, submission intake, and the pre-dispatch repairs (dispatch base
  re-record, validation retry). It holds the source-promotion, lead-check and
  re-key handlers. Same-name `Engine` methods delegate to its `Operations`. A
  failed run settles by `operationFailureSettlement`, a pure function over the
  facts re-read after the throw: a committed result, a deferred validation, the
  pre-send receipt that proves a refusal, and the state and effect status.
- `core/workspaces/workspace-provisioning.ts` creates, compares and removes a task's
  sibling worktrees, refreshes checkout siblings, prepares its worktree links
  and reads its stash list. Same-name `Engine` methods delegate to it.
- `core/dispatch/worker-launcher.ts` creates a task's worker: one creation per task at
  a time on each engine, one run identity claimed in a transaction, then the
  agent and its launch failures. Same-name `Engine` methods delegate to it.
- `core/recovery/creation-recovery.ts` recovers a proven-absent worker and an unowned
  workspace creation. `workspaceReplayAllowed` and `absentWorkerStep` are the
  pure rules. Same-name `Engine` methods delegate to it.
- `core/store/projections.ts` runs what stays outside the delivery lanes: workspace
  titles, the cleanup drain and its retry timers, runtime-retirement scheduling
  and the occurrence counts a wake or an effect retry waits on. Same-name
  `Engine` methods delegate to it.
- Coordinator recovery is one stage per module under `core/recovery/`.
  `recovery.ts` is the `Recovery` surface `Resolution` constructs and wires the
  stages together. `coordinator-route.ts` decides whether a task needs a
  coordinator and launches it; `coordinator-pass.ts` observes that exact run until
  it reports; `coordinator-episode.ts` owns the episode's durable bookkeeping
  (bindings, refusal, release, escalation). `coordinator-report.ts` holds the pure
  report rules — `taskProgressDigest`, `coordinatorReportMatches`,
  `coordinatorActionPlan` (a report to verb arguments, or the refusal naming why it
  no longer applies) and `recoverySettlementPatch` (what settling the report
  changes on the task); `coordinator-settlement.ts` applies a report as the owner
  verb it names; `responsible-fault.ts` settles the Spec 058 mechanical faults code
  can settle; `pseudo-checkpoint.ts` owns the post-budget pseudo-checkpoint rule.
  Same-name `Engine` methods delegate to `RecoverySettlement` and
  `settleResponsibleFault`.
  `core/questions/origin.ts` keeps the one task-owner field exact and records a
  missing origin while delivery is still owed, with planner notice routing and
  reparent authority for projects whose origin is unavailable.
- `core/closeout/workspace-lifecycle.ts` owns workspace cleanup and post-merge workspace
  recovery; `core/verbs/disposition.ts` owns cancellation and supersession
  ([Spec 003](specs/003-post-dispatch-task-disposition.md)), including its
  `Dispositions` class: the operator and bulk entry points. Same-name `Engine`
  methods delegate to it.
- `core/workspaces/worktree-validation.ts` detects a live QA process in a task worktree
  so a callback reminder is extended, not escalated.
- `core/telemetry/live-run-presence.ts` projects the live run set into the operator's
  workspaces: one reused terminal tab per workspace and selector follows a run's
  live output, and the workspace carries "QA running" or "Testing" while it
  runs. Both are best effort ([Spec 035](specs/035-host-run-scheduler.md));
  `core/machine/live-output.ts` is the capped live-log writer the validation and QA
  supervisors tee into.

### External boundaries

- `hosts/paseo/adapter/` is the Paseo SDK boundary; `hosts/paseo/index.ts` exposes the
  service adapter factory and `core/host/index.ts` owns the neutral adapter port.
  `core/host/host-policies.ts` supplies core policy delegates at service composition; the adapter imports no core
  implementation. `core/host/admission.ts` admits,
  coalesces and measures every call by class. `shared/host.ts` is the host
  interface (its `catalog` method is the first). Core reaches it through
  `core/host/host-facade.ts`, which reads the owner's adapter at each call. The
  engine adapter proxy also normalizes agent-ID arguments at the transport
  boundary, including legacy direct adapter calls: qualified IDs are unwrapped
  only when their host matches the selected host, and otherwise refused. The
  façade provides the typed delegates for origin, observation, timeline, stop,
  archive, usage, messaging and native questions. `shared/profiles.ts` owns
  Nucleus's own profile records and their per-host availability, and
  `core/planning/profile-import.ts` makes the one-time copy of a host's profile list
  ([Spec 052](specs/052-usage-level.md)).
- `hosts/paseo/adapter/host-workspaces.ts` is the Paseo host's workspace calls behind the
  `Host` contract: the complete native inventory, the project lookup, the native
  registration, the title write, the registration handle (`workspaceRef`) that the
  continuation preflight, the process proof, task workspace retirement and external
  archive refresh and read, the handle's native archive, and the archived-state read.
  It also holds the complete thread inventories (`workspaceThreads` for the
  registrations at a preserved folder, archived included; `activeThreads` for review
  entry), the complete terminal list (`workspaceTerminals`), each walked to its
  positive end and refused as text rather than read as empty. The handle's refresh
  and archive are the daemon's own promises and its record is read when the caller
  reads it, so no turn is added. The host reads the adapter's daemon surface per
  call, so a test's replaced surface is the one called.
- `core/workspaces/workspace-lifecycle.ts` (`WorkspaceLifecycle`) owns a task workspace's
  lifecycle policy: storage preflight and volume admission, the owned path and
  data-dir proofs, the Git populate, creation with its progress steps, the
  one-folder registration decision, orphan inspection and removal, and recovery at
  the accepted PR head. It reads the host through a narrow surface — the complete
  inventory, the project lookup, the native registration, the catalog, the process
  scan and the progress hook — and reaches the adapter's own machine seams
  (`dataDir`, `placement`, `ownedPathFor`, `ownedDataDirFor`) and its entry points
  (`findWorkspaces`, `inspectWorkspaceCreation`, `inspectOrphanWorkspace`) through
  the host at every internal call, so an instance override still governs the whole
  operation exactly as the adapter's own self-calls did. `core/host/host-policies.ts`
  keeps the core delegates and the review-entry busy reason; every host fact is read at the call, so a test's
  replaced placement, data home, process scan, progress hook or daemon surface is
  the one used.
- `core/workspaces/workspace-continuation.ts` (`WorkspaceContinuation`) owns the retained
  and closeout workspace policy: the continuation preflight's owned-path
  admission and identity comparison, the process proof over the host's own
  process table, and the closeout workspace's branch-off identity, its one
  registration lookup and the exact-head and cleanliness proof a recovered
  checkout must pass. It reads the host through a narrow surface — one
  registration's handle and its refresh, the complete inventory and the native
  worktree registration — and reaches `placement`, `ownedPathFor` and
  `hostProcessListing` through the host at every internal call, so an instance
  override still governs the whole operation exactly as the adapter's own
  self-calls did. `core/host/host-policies.ts` keeps the five same-name plain-return
  delegates; every refusal, its order and its text stay core's.
- `core/workspaces/owned-workspace-archive.ts` and `core/workspaces/external-workspace-archive-policy.ts`
  own archive placement, ownership, source, participant and teardown decisions.
  They read native workspace and thread observations through the host at their
  original call sites and retain adapter overrides for internal policy seams.
  Uncertain native archive outcomes do not authorize another archive call.
- `hosts/paseo/adapter/host-messages.ts` owns Paseo's retained-agent handles, idle delivery
  queue and interrupt-and-continue call. `core/review/review-policy.ts` owns registration
  and review-entry decisions, review independence, retained binding, workspace
  placement and send fences, using host handles at the original call points.
  Adapter delegates and internal seams remain late-bound. The host reads the
  adapter's native surface per call;
  uncertain sends keep their recipient queue fenced until the send settles.
- `hosts/paseo/adapter/host-questions.ts` owns the Paseo host's native question calls: listing and
  answering a thread's pending questions, reading its answered ones, and raising and
  answering a decision on the task thread, including the native decision wire
  (`raiseNativeDecision`). `hosts/paseo/adapter/paseo.ts` keeps same-name delegates; the identity
  checks and the permission reads and answers are the host's. Core keeps delegation,
  intents and the event sequence in `core/questions/native-questions.ts` and `core/questions/questions.ts`,
  and the provider list `supportsNativeQuestions` in `core/questions/native-decision.ts`, which
  routing reads synchronously. The host reads the adapter's daemon surface and timeline
  read per call.
- `hosts/paseo/adapter/host-asks.ts` owns the Paseo host's native ask, consult and decider calls: the
  planner and reviewer asks' idle send and the native agents a consult reviewer and a
  decider start in the task workspace. `hosts/paseo/adapter/paseo.ts` keeps same-name delegates and
  the idle delivery path (`sendWhenIdle`), which the host reads per call. The routers
  stay in core: `core/questions/delegation.ts`, `core/questions/agent-asks.ts`, `core/questions/ladder.ts` and
  `core/questions/questions.ts` choose the recipient and profile, build the stable request and
  label identities, own delegated authority and follow-up, and take the answer from the
  command receipt, never from the recipient's chat output.
- `core/dispatch/agent-creation.ts` builds a launch's callback facts: the run ticket,
  the MCP reporting binding, the callback and scratch environment, the prompt
  and the stable request and label identities. A host receives them as a
  `HostAgentSpec`. `core/dispatch/agent-policy.ts` owns the worker create, guard before
  each create and MCP fallback; the host keeps native configuration and creation.
  Core owns the binding file's removal on that fallback. `core/intake/reporting-files.ts`
  owns reporting fallback text and ticket cleanup.
- `core/machine/machine-ports.ts` owns the machine work no host application decides:
  the Git and forge checks, the operator's validation and scratch policy, and
  the injected load and process probes. A host adapter keeps those names as
  late-bound delegates, so an instance override still wins and a synthetic
  adapter that omits a probe observes none.
- `core/git/index.ts`, `core/git/git-identity.ts` and `core/git/git-fetch.ts` verify
  repository identity and perform gated Git effects. Exact-head identity is read
  from the filesystem; working-tree walks are async git so they delay the calling
  task, not the executor's other work. Fetches serialize per common Git
  directory. `core/forge/index.ts` performs gated GitHub effects. A required check
  pending past recent durations for its name (30-minute fallback) raises
  attention with the job URL. `core/forge/pr-status.ts` display observations are not
  merge authority.
- `core/git/git-auth-retry.ts`: fetch, push and remote inspection retry a definite
  SSH authentication failure three times in total, with 2 s then 5 s waits (Tom,
  2026-09-24). Exhaustion is a host-environment hold, not quota exhaustion; only
  a pre-publication rejection may repeat a push.
- `core/intake/report.ts`, `service/callbacks/callback.ts` and `bin/mcp-report.mjs` bind results
  to a task/run credential. Every transport carries every field the canonical
  schemas accept and drops or infers none. `shared/service/callback-client.mjs` holds
  the pure transport; the root `mcp-report.mjs` keeps paths issued to retained
  sessions. Review entry preserves externally owned PR workspaces.
- `core/hooks/hooks.ts` is the hook domain's front: the lifecycle entry points,
  closeout authority, the finished-task stop and compatibility re-exports. Each
  mechanism behind it has one owner: `hook-occurrence.ts` owns durable occurrence
  identity and transitions, `hook-execution.ts` runs one occurrence's read-only
  proof, `hook-publication.ts` owns the integration-write commit, push, canonical
  sync and cleanup, `hook-reconcile.ts` owns the restart reconciliation state
  machine, `hook-retry.ts` owns retry and disposal proofs, `hook-retention.ts` owns
  the retention gate and its reconciliation, `hook-checkouts.ts` owns the
  Queue-owned isolated checkout and the integration base, and `hook-result.ts`
  owns the closed result envelope and failure evidence.
  `core/hooks/hook-manifest.ts` owns manifest discovery and program/instruction
  pinning, including named tool resolution; `core/machine/process-exec.ts` owns
  bounded process execution; `core/git/git-snapshot.ts` owns status, snapshots
  and checkout/path proofs. `core/merge/prospective-merge.ts` owns candidate
  construction, warm-checkout proofs, pinned candidate recovery and the
  prospective-merge gate through a narrow store/Git/delivery context.
  `core/qa/project-validation.ts` owns background validation, supervisor watches
  and durable validation evidence; `core/hooks/hook-replay.ts` owns automatic replay
  proofs and the shared occurrence renewal path. Both use narrow contexts and
  keep delivery with `RepositoryHooks`.
  `core/hooks/hook-isolation.ts` owns shared isolation paths;
  `core/hooks/hook-context.ts` owns the hook context and result types plus the
  record and hold-reason codecs.
  These modules never import `core/hooks/hooks.ts`;
  `core/git/index.ts` reads manifests directly from the manifest leaf.
  Every stored occurrence carries its immutable event payload
  ([repository hooks](contracts/repository-hooks.md),
  [Spec 001](specs/001-generic-repository-hooks.md),
  [Spec 004](specs/004-trusted-host-hook-runners.md)).
- `skills/nucleus` is the agent-facing skill for submission, planning
  records and disposition. Documentation structure stays in Northstar.

## Service boundary

Nucleus runs as a persistent standalone service
([Contract 007](contracts/service-boundary.md),
[Spec 013](specs/013-standalone-queue-service.md)): `service/runtime-owner.ts`
owns it. `shared/service/` holds the framed protocol and authenticated client,
`service/` owns the sockets, and `hosts/paseo/plugin/` holds the thin bridge.
`bin/queue-service.mjs` is the executable. Plugin reload doesn't stop it; an incompatible build or host
session change drains and replaces it. Any spawn while an owner pid is alive
starts as a standby for it, and opens the store the bridge already selected
(`--data-dir`). `queue.service-state` reports the
bridge state. Activation of `current` and installer entrypoints is a roll
step on the bridge, retried each check, not gated on connect. A failed
activation stays `retrying` with the error in detail until it succeeds, and
`rolled` waits until the service answers the target build.

The native bridge fetches only the active view's bounded projection: revisioned
board state, one-task detail on selection, and telemetry or configuration on
those views. `queue.snapshot` is a paged compatibility read, not a UI source.

## Repository layout

The root holds the two Paseo entries, front doors, configuration, the MCP
compatibility entry and top-level docs. Source lives in `core/`, `service/`, `hosts/`, `client/`
and `shared/`, unit tests in `test/`, operator commands in `bin/` and opt-in
live scenarios in `scripts/acceptance/`
([repository layout](contracts/repository-layout.md)).

- `scripts/run-tests.ts` runs `test/*.test.ts` at concurrency 6 with a
  120-second budget per file; wall-clock oracles stay in the serial timing lane
  (10 minutes per test). Run selected timing files with `npm run test:timing -- <files>`;
  the store compaction benchmark is excluded from both default lanes and runs only when explicitly selected.
- `effigy test unit -- test/<file>.test.ts --test-skip-pattern=<pattern>` passes
  Node options as separate argv; the runner puts options before files, because
  Node ignores options after the first file. The `unit` suite runs `npm test --`.
- A family that lacks headroom keeps cases in `test/<family>.cases.ts` and runs
  as `test/<family>-<k>.test.ts` shards through `test/support/sharded-test.ts`;
  each case registers exactly once, weighted with `weighted(n)`. The timing lane reads an entry with its case file (`entrySource` in
  `scripts/timing-source.mjs`).
- A family with identical starting repositories builds them once per process
  as a `GitSeed` (`test/support/git-seed.ts`) and copies them into each fixture.
- Fixture children: a child is owned only once its pid and start-identity
  record is complete, made once when the bridge reports it. A recycled pid, an
  unreadable identity or a pid found only in an identity file is never
  signalled or counted settled, and argv never decides liveness.
- Teardown closes new spawns, drains the service, proves the process and its
  group gone and lets the bridge's in-flight work settle before disposing the
  data directory; a teardown that can't prove settlement leaves the directory.
  A liveness probe proves absence only on `ESRCH`.

## Deployment and data

The source checkout is the installed trusted plugin. Runtime state lives in the
daemon home's `northstar-queue` directory, outside Git: `queue.sqlite`,
`settings.json`, the callback socket, tickets
and the reporting helper. Never move or publish that state with the repository,
and never change the registered plugin path. Dependency installation is declared
in `effigy.toml`. Task checkouts get only declared sibling links
([orchestration](contracts/orchestration.md#orphan-worktree-after-a-timed-out-create));
project QA runs setup itself.

Review entry for externally authored PRs is implemented
([Spec 017](specs/017-external-pr-review-entry.md)).
