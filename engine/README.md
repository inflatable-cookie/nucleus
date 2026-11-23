# Nucleus engine build plan

[Spec 070](../docs/knowledge/specs/070-small-engine.md) owns the model. Milestone 1
runs one synthetic task from work through closeout on T3. The Rust engine is off
by default, uses its own settings and database, and admits only the explicitly
configured fixture repository. The planner checks the run by hand. The board
switch starts in milestone 2.

A missing review checkout is recovered at the verified PR head before
reserving a run. If recovery fails, the task waits for another check.
An unsent create only has a provisional thread in its run slot. A possible
send or a positively observed completed turn binds the retained thread.

## Crates and review slices

| Slice | Crates | Boundary |
| --- | --- | --- |
| 1 | `nucleus-core` | Typed task, commands, transitions, pure `decide`, and a test for every decision arm and both gates. |
| 2 | `nucleus-store`, `nucleus-work` | SQLite task and history transactions, settings paths, and worktree allocation and retirement. |
| 3 | `nucleus-forge` | GitHub PR identity, exact-head checks, merge and merged-head readback. |
| 4 | `nucleus-hosts` | A small host interface and the authenticated T3 adapter, tested against RPC fixtures. |
| 5a | Core, store and T3 interfaces | Add versioned task writes, planner notice delivery and native wake hints. |
| 5b | `nucleus-service` | Run the task pass with due times, command preflight and authenticated reports. |
| 5c | JSON API and `nucleus-cli` | Serve the task view, invalidations and commands. Configure and run the isolated service. |
| 6 | `nucleus-acp`, T3 parenting | Present one task as one host-neutral ACP session. Parent T3 role threads under that session. |

Keep PRs near 1,500 changed lines plus tests. Open each against `main` once its
dependencies land. The planner arranges independent review and merges. Run
formatting, check, strict Clippy and nextest for changed crates through Effigy,
with a shared Cargo target under `NUCLEUS_SCRATCH_ROOT`. Oxide uses its registered
removable pool and refuses a pool path inside the task's Stash scratch directory.
Cargo deny and the whole workspace run at milestone QA. The fixture exercises
success, a stopped run, and readback after uncertain delivery before the
planner's live check.

Use `publish = false` for workspace packages. The Longhorn revision
`049392e27f93d642839b82c28d217c1f353e569e` is an interim pin until `v0.6.0` is
tagged. Crates using Longhorn require Rust 1.97.1.
`longhorn-config` owns the versioned engine and Storage settings domains, atomic
updates and config backups. `longhorn-storage-layout` resolves their roots and
the separate engine data root. `longhorn-git-workspace` compares exact worktree
and repository identity and supplies the bounded Git executor. `nucleus-work` owns allocation
and uses explicit `git worktree add/remove` without force. `longhorn-redact` and
`longhorn-support-log` cover adapter diagnostics. `longhorn-operation` leaves
persistence, deduplication and restart recovery to the caller, so it adds no
needed behavior here. Use `longhorn-update-install` when verified distribution
and roll enter scope.

Worktrees default to `<workRoot>/<repo-hash>/ns-<task-id>`. Barge's `barge` library
provides optional lease, lookup, hold and return. The fixture uses `workRoot`.
The Barge checkout has the worktree API and no release tag. Enable the pool
setting after a compatible dependency pin and a hold that covers the T3 turn
and its tools are available. Barge main at `47e52ea9b40e1cb4bc16c8f0e201732d2465eb56`
has `WorktreeHold` support for an inheriting child. The T3 process spawner needs
to use that hold for a pool; `existing_worktree` passes only a path. For both
backends, inspect cleanliness just before
retirement and keep dirty or unpublished local work in place. Index flags that
can hide edits also keep the checkout in place.

Git receives a pathname after the no-follow directory check. A root or bucket
replaced during that interval can redirect allocation. The work root belongs
to the operator on the single-user host. A follow-up will anchor the destination
to a verified directory handle through the Git write.

The engine opens its own explicit Longhorn portable profile. Its machine-state
settings are versioned in `state/engine.json`, with the engine disabled by
default. The database, work and scratch roots must stay on the configured
writable volume. Check the pinned native volume ID and walk directories without
following links before creating storage.

## State and decisions

The [SQLite schema](crates/nucleus-store/src/schema.sql) stores tasks and display
history in its own `engine.sqlite`. It uses WAL and transactional schema
versioning. The brief's text, version and digest are stored together. Store
a human acceptance, when needed, as an exact-head
alternative in the verdict slot, including the accepting actor and authority.
Resolve the responsible planner from the task's origin and live host inventory.
Append audit history in the state transaction. The pass loop schedules active
rows. API history
and live notifications may read the event log.

Normalize the relevant observations to one signal per phase. The bound run
takes precedence over downstream work until its turn is quiescent. A required
unknown read yields a wait before any action that depends on it. Optional and
irrelevant reads do not delay a task. In this sketch `Remaining` is derived from
the current phase and head's failure count, and `Last` means the observed
failure is the third.

```rust
match (phase, run_state, observation) {
    (_, Revoked, Quiescent) => Advance(phase), // clear the revoked run
    (_, Revoked, _) => Wait(reason, retry_at),   // reconcile the stop
    (Done | Cancelled, _, _) => Nothing,
    (_, _, Held | QuestionOpen) => Wait(reason, None),
    (_, _, Unknown) => Wait(reason, retry_at),
    (_, Bound(_), Permission | Input) => Wait(reason, retry_at),
    (_, Bound(_), Starting | Running | IdleWithoutTerminalRun) => Wait(reason, retry_at),
    (Reviewing, Bound(Reviewer), PreparedInvalidAfterPossibleSend) => Revoke,
    (Working | Reviewing, Bound(role), Failed(Remaining)) => Relaunch(role),
    (Working | Reviewing, Bound(_), Failed(Last)) => Ask(retry_question),
    (Queued, Unbound, Ready) => Advance(Working),
    (Working, Unbound, WorktreeReady) => launch(Worker, retained_thread),
    (Working, Bound(Worker), ReadyForReview) => Advance(Reviewing),
    (Working, Bound(Worker), WorkQuestion) => Ask(question),
    (Working, Bound(Worker), HandoffNeedsRepair) => Ask(repair_question),
    (Reviewing, Unbound, OpenPrAtHead) => launch(Reviewer, retained_thread),
    (Reviewing, Bound(Reviewer), ApproveAtHead) => Advance(Merging),
    (Reviewing, Bound(Reviewer), ChangesAtHead) => Advance(Working),
    (Reviewing, Bound(Reviewer), WorkQuestion) => Ask(question),
    (Reviewing, Unbound | Bound(Reviewer), HeadChanged) => Advance(Reviewing),
    (Reviewing | Merging, Unbound, PrNeedsRepair) => Ask(repair_question),
    (Merging, Unbound, OpenHeadNeedsReview) => Advance(Reviewing),
    (Merging, Unbound, ApprovedButPending) => Wait(reason, retry_at),
    (Merging, Unbound, ApprovedButBlocked) => Ask(repair_question),
    (Merging, Unbound, ApprovedAndReady) => Merge,
    (Working | Reviewing | Merging, Unbound, MergedWithAuthority) => Advance(Closing),
    (Working | Reviewing | Merging | Closing, Unbound, MergedNeedsAcceptance) => Ask(accept_question),
    (Closing, Unbound, ClosureReady) => Close,
    (Closing, Unbound, NoConfirmedMerge) => Ask(repair_question),
}
```

In Rust, the phase, run and adapter observations produce a typed signal for
the exhaustive decision match. A successful callback
waits for a terminal turn before advancing. A changed head also waits for the
old turn to end or be stopped before resetting the review. Confirmed non-delivery,
authoritative disappearance of a previously launched run, and a terminal run
without a report are failures. Transport and snapshot uncertainty advance no
counter. On launch or relaunch, continue the retained role's exact thread after
an idle read. Create only on first launch or after confirmed disappearance.
Wait for busy or unreadable threads. A changed head or phase resets attempts.
An explicit `move` also resets them when the phase and head stay the same. A worker
revision must produce a new PR head before another review. An external merge during a turn is processed
after the run settles. `Close` finishes only after fresh merged-head evidence and
workspace inspection. Dirty or unpublished work is retained and shown at closeout.

The commands mutate the same row. `hold` and `release` toggle the hold,
`amend` versions the brief, and `answer` resolves the current question. `move`
and `cancel` revoke the run credential immediately. The pass loop reconciles
the stop before releasing the workspace or starting another run. Direct moves
never give a head merge authority. The merge and clean-worktree gates also
apply to manual commands.

## T3, reports and GitHub

T3 is the engine's only supported host. The host interface describes the reads
and effects the task engine needs.

Every T3 mutation goes through the destination gate after the exact native
read. The gate checks the frozen destination against the fixture's Git origin
and current T3 project root. This includes interrupt, queue cancellation,
archive, unarchive and unsettle. Role writes need their owned checkout.
Planner writes need an exact thread in the fixture project. Review sends
also check the open PR and clean checkout after native authorization.

- Get a ticket with `POST /api/auth/websocket-ticket/rpc`, then open `/ws`
  with `orchestrationProtocol=2`. Use `server.getConfig` to check the configured
  provider and model. Pre-register the single fixture project for milestone 1.
- `orchestration.subscribeShell` can send repository enrichment snapshots before
  `synchronized`. These update repository metadata. Project binding and planner
  routing use the authoritative Shell snapshot.
  [T3 Shell stream](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/ws.ts#L1301-L1345)
- `orchestration.launchThread` takes explicit command, thread and initial-message
  IDs and `existing_worktree`. Bind the run and immutable launch inputs before
  sending. The task assigns a monotonic launch instance and derives a fresh
  bearer from it. Derive native IDs from the persisted instance and freeze the
  exact payload. Before any send, read that exact native thread and message.
  Adopt a matching delivery that already exists. Once an exact read authorizes
  a send, persist the possible send time before writing. A replay also requires
  ten minutes since the last possible send. Keep the payload and native receipt
  ID on every attempt. T3 checks the receipt
  under its dispatch lock. Launch uses the same receipt path for the thread
  claim and first message.
  [Dispatch receipts](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/orchestration-v2/Orchestrator.ts#L16305)
  [Launch receipts](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/orchestration-v2/ThreadLaunchService.ts#L1389)
- `orchestration.subscribeThread` requests a synchronized, full snapshot of the
  exact thread. Settlement requires coverage of all provider sessions and turn
  items. Pending tasks and active command, tool and subagent items keep the
  thread busy. An omitted or windowed roster leaves settlement unknown.
  [T3's background-work derivation](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/packages/shared/src/orchestrationV2PendingBackgroundWork.ts#L225)
- A pass shares one bounded process inventory across checkout checks. The Mac
  adapter cross-checks `lsof` against a PID enumeration of the local T3 user.
  An open file or working directory under the checkout is busy. An unaccounted
  live PID, undecodable path, incomplete listing or warning leaves settlement
  unknown. Decode `lsof` escapes before comparing path bytes. Run the
  engine and T3 under the same local user with private task checkout roots.
  Use a fresh pass after a launch can have started new processes. Barge pools
  require the host-side inherited hold.
- `orchestration.dispatchCommand` with `message.dispatch` starts a new turn in
  a retained, idle thread. Reopen an archived thread before reusing it. On
  revocation, clear an unsent request directly and stop a confirmed delivery
  with `run.interrupt` or `queued-run.cancel` at its exact native run ID. If
  delivery is still uncertain after the late-reply window, replay with the
  credential already revoked. When the review head is unchanged, replay
  requires a fresh open PR and clean checkout at that head. When it has moved,
  reconcile the old wire once, stop any settled delivery's live turn, and
  archive the thread before clearing the run. Read back the settled state
  before releasing the checkout. The milestone 1 fixture can use standalone
  threads. The host adapter prepares that launch wire, so the service uses the
  same task and run model when the adapter parents a thread under an ACP session.
- The role runs call a local authenticated report endpoint via an owner-only
  ticket outside the checkout. The prompt names the ticket path. The service
  verifies the task, role, current run, credential and requested review head.
  A worker sends its PR and head or a question. A reviewer sends its verdict,
  exact head and summary or a question. The same callback is harmless when
  retried while its run is current. Stale credentials cannot change task state.
- Read the GitHub PR against the task's repository, base and branch. Read
  mergeability, draft status, exact-head checks and review requirements. A
  separate reviewer turn examines the requested commit. Milestone 1 uses its
  authenticated verdict as Nucleus approval. Branch protection remains in
  force. Formal GitHub review publication needs a separate reviewer identity
  on repos that require it. Merge with `PUT /repos/{owner}/{repo}/pulls/{n}/merge`
  and the reviewed `sha`. On a lost response or head mismatch, read the PR
  again. Use `merged` and its merge commit for readback, including squash merges.
  An externally merged head with no verdict requires recorded human acceptance.
  [GitHub's exact-head merge endpoint](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)

## Service pass

At startup, enqueue every active task, including a cancelled task with a pending
run. Keep the earliest due time for each task in memory. Receipts and commands
wake that task after their transaction commits. A T3 stream wakes the task when
its known thread changes. Stream events are hints. A disconnect wakes watched
tasks, and a periodic active scan catches any missed wake. The next due time
drives the timer even when the scan is idle.
The backstop pages through the active index with a fixed read budget.

A pass takes tasks that are due and shares one bounded process inventory.
For each task, read its row, then fetch the exact T3 turn, PR and checkout facts
needed for its decision. Process coverage and the full provider projection gate
continuation and release. A live process keeps the checkout in use regardless
of elapsed time. The service rechecks Git cleanliness just before removal.
Waits schedule another check. A provider retry deadline takes precedence over
the ordinary check interval. Unknown facts leave the task waiting for a read;
the existing decision table owns questions about the work.

Read adapters outside the store lock. Every pass write compares the task row's
version and run instance with what it read. A stale result drops out and wakes
the current task. Effects and commands acquire a per-task fence only after
preflight. Store state and audit together, including the send intent before a
native write. The board reads committed rows without waiting on GitHub or T3.
Keep due times, load observations and displayed waits in memory. An idle process
slot and acceptable local load permit a new launch. Pressure reschedules it
without spending an attempt. A fresh pass checks process custody after launch.

A definite GitHub head mismatch retires approval and keeps the bound PR in
Merging until a read shows a new head. A refusal followed by incomplete
readback waits for fresh evidence and honours any forge retry deadline.
A confirmed rejection of a superseded review stays in the revoked run slot
until T3 confirms archival or absence. Later passes only reconcile that
disposition. They never replay the rejected launch.

`next` and commands run the same preflight using the pass's forge observation
for the committed task version. Answers bound to a PR head, amendments to
tasks with a bound PR, and moves through the merge gates check that head.
On missing evidence, the command returns
HTTP 202 with `status: pending` and the version, and wakes a check. The client
can retry the command when `next` shows it ready. Merge and worktree removal
still check fresh evidence at the effect.

An open question owns its message intent. Resolve the project's most active
responsible planner at send time. Keep the thread ID only as part of the native delivery
binding. Reconcile that binding before rebinding when the planner changes.
A planner answer must match the current binding.
Unsettle a settled thread using its ID and the high-water sequence from the
same exact snapshot, then read it back. A settle emits a thread event, and the
snapshot reads the largest event sequence for that thread in the projection
transaction. A later settle advances the sequence even when it reuses a
timestamp. Queue behind an active turn and let an idle planner start immediately.
[T3 settle event](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/orchestration-v2/Orchestrator.ts#L5564-L5626)
[T3 thread snapshot](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/orchestration-v2/ProjectionStore.ts#L7075-L7093)

Record the send marker after the preflight, just before dispatching the frozen
message. The notice is delivered when it initiated a turn that started. If a
person promotes the notice to a steer in T3, look for the completed user-message
item with the exact message and target turn IDs. Replay uncertain delivery
under the same ID after the host's wait window. A durable rejection or a
terminal turn that never started permits a fresh binding. Clearing the question
also clears its binding.

## ACP task sessions

`nucleus-acp` is a host-neutral, model-free ACP agent over stdio. Each task has
one service-minted session with task-scoped credentials outside its Git checkout.
The agent reads the same committed task view and current wait as the board.
It follows task invalidations and sends the same typed commands as the CLI,
including answers. A committed command wakes the task. The agent keeps its
presentation cache in memory and has no access to the engine store.

Preserve the stdio protocol from [Spec 065](../docs/knowledge/specs/065-acp-task-session.md).
`initialize` advertises `loadSession: true`. An unbound `session/new` is inert;
it refuses prompts locally. An unbound `session/load` refuses the attachment.
A bound attach rebuilds the full current `plan`, `tool_call` list, status and open
question. One plan covers Queued, Working, Review (with its round), Merge and
Close. A persistent wait updates the current step's status. Each worker or
reviewer run gets one tool call keyed by its launch instance. The service view
provides its purpose from the brief's first line or the review step, with the
current tool, command, file or test and its observed start time when available.
These are display facts from the exact native turn. Use a redacted tool summary
and compute elapsed time at display. The agent updates the call in place.
Messages cover the PR link, verdict findings, merge, question and finish.
Coalesce repeated state and keep retries and transient reads out of the thread.
Clients without structured updates still receive the human-facing milestones.
The opening prompt establishes the session. The adapter can supply silent hold
and ignore patterns. ACP cancellation releases the presentation turn. Task
cancellation goes through the same command preflight as other clients.

Keep host execution and parenting separate. The engine uses its host interface
to prepare a launch, observe a run and stop it. A host's parenting adapter
ensures the session is open and creates or continues the role's child there.
T3 runs `nucleus-acp` in the session thread. It holds or re-enters that thread,
reads its live run and root node, and sends `delegated_task.request` with the
bound launch identity. The adapter reuses each role's retained child and settles
its completion delivery with `delegated_task.completion-delivery.dispose`.
The service continues to see its role thread and exact run. Verify reattach
after closeout and checkout removal in the parenting fixtures. ACP and T3
parenting follow the milestone 1 proof and precede the first real project.

## Board

The JSON model comes from the engine. A task list returns identity, phase and
current wait or question. Detail adds the brief, current run, PR, verdict,
hold and paged event history. A `next` read returns the current phase, wait,
question and available commands. A typed command endpoint handles `move`,
`answer`, `cancel`, `amend` and `hold`/`release` for the CLI and board.
`/v1/settings` reports the active work and scratch roots and role profiles.
Milestone 1 configures the engine setting locally. The board's settings writes
and optional pool controls follow their migration milestones.
`/v1/events` emits the task ID and version on a change. A reconnect or missed
interval invalidates the list and visible task views. Task commands use the configured control
credential. Each run has its own callback credential, including its task and
role checks. The API exposes the run's progress without its ticket or wire.

The fixture uses the `nucleus-engine` binary. Run `configure --home <profile>
--enable` with an existing profile on the pinned volume. Start `serve` with
that profile, a project file for the authorized fixture, and the local T3
endpoint. Set the control key, T3 bearer and GitHub token in the environment.
The CLI's `admit`, `task`, `next`, `history` and task commands use the loopback
API. Every route requires the configured loopback Host and a same-origin Origin
when supplied. `report` reads the role's owner-only ticket and the report from stdin.
For the live proof, bind a separate key to the idle fixture origin thread with
`--fixture-origin-thread` and `NUCLEUS_ENGINE_FIXTURE_ORIGIN_KEY`. Use that key
to submit and answer as the bound fixture planner.

| Keep | Reshape | Remove from Rust tasks |
| --- | --- | --- |
| `client/web` shell and T3 theme, sidebar shades, board layout and common controls | `client/queue.tsx` and `client/board` read the new list. Queued, Working, Reviewing, Merging and Closing map to phase groups. Done and Cancelled appear in history. | Incident, wait and recovery record cards. A task shows its current wait and hold. |
| Task panel shell and activity layout | `client/task` shows brief, current role/thread, PR/head, verdict, hold and history. `next-section` shows the reason and the five commands. | Explicit-command and proof buttons, effect retry, specialised routing and closeout controls. Use `move`, `cancel`, `amend` and `hold`/`release`. |
| Inbox layout and shared question controls | The Inbox shows the task's one question and lets the assigned planner submit `answer`. | Ladder rungs, escalations and recovery ownership. One question goes to the assigned planner. |
| Settings shell and Storage form controls | Settings and Storage read the Rust domains. `client/web` transport and live channel adapt at the data boundary. | Legacy per-task tuning and recovery settings. Planning records and legacy features keep their current route while the old engine drains. |

## Settings migration

Keep the Settings tabs, shared controls and save feedback. Use one noun per
control, put explanations in `?` popovers, autosave, prefer dropdowns and put
Remove inside the editor. Milestone 2 gives
each group a versioned Longhorn config domain and reads the live catalogue or
health separately. Ordinary domains and their backups carry credential
references. T3 and provider tokens stay in secure storage.

| Current screen | Domain | Keep as is | Reshape | Drop |
| --- | --- | --- | --- | --- |
| Profiles, editor, subscriptions | `profiles` (user config) | Profile names, provider and model picker, supported options and subscription display | Configure worker and reviewer profiles against the live T3 catalogue. Map usage levels and project overrides to profile IDs. At Low, Normal and High, Frontier requires an explicit per-role planner request with a reason. | Recovery coordinator and ladder profile groups, whose roles have been retired. |
| Dispatch limits | `dispatch` (user config) | Usage slider, autosave, global and project slot controls and project overrides | Carry over slots, local load, host-call concurrency, budgets and usage levels. Extend a budget once automatically, then ask the planner. Show which setting is in force and which launch it delays. | Wall-clock stall rules, escalation and outage timers. The pass reads activity and schedules checks. Keep papercut limits with the existing papercut service while it owns that work. |
| Projects | `projects` (project-scoped config) | Project and repository list, editor and lane selection | Bind repositories and base branches. Keep the per-repository hung-tool limit in project settings. A command with no output for that interval is terminated, with 30 minutes as the default. Resolve the most active responsible planner live at send time. | Stored planner thread selection, recovery-agent registration and episode controls. The live role resolves ownership and task commands own cancellation and holds. |
| Storage | `engine` (machine state) | Work root fields, resolved paths, reset and save feedback | Resolve the pinned work volume, engine database, work and scratch roots through Longhorn. Expose the optional Barge pool when its host hold is ready. | Paths for retired engine side stores. |
| Hosts | `hosts` (machine state) | T3 connection status and its connection editor | Configure the T3 endpoint and credential reference. Read reachability and catalogue state live. The adapter translates the canonical profile vocabulary. | Multi-host default picker, retired adapter settings and host-specific profile mapping controls. |
| Backups and Telemetry | Existing Longhorn config backup scopes and engine display history | Backup status, restore controls and useful usage summaries | Show verified config backups and the new engine's task activity with their own provenance. | Recovery attempts, incidents and escalation counts. |

The service validates each domain and applies its versioned write through
Longhorn. Keep task and planning records in their owning stores. Loading a
setting or restoring a backup grants no task or merge authority.

Port the worker start matrix and the reviewer bracket matrix cell for cell from
[Spec 052](../docs/knowledge/specs/052-usage-level.md). Preserve the critical
cases, smoothed Maximum and its one Frontier climb for high-complexity tasks,
and the step-up after an applied changes-required review. Derive that trigger
from the existing phase, verdict and attempt facts. Read the retained worker's
actual profile for the reviewer bracket. Use the existing five-stop demand
weight slider and [Spec 053](../docs/knowledge/specs/053-demand-based-selection.md)
to pick within a bracket. Keep the selectors pure and reproduce every worker
and reviewer case from `test/demand.test.ts` as a table-driven Rust test. The
retired coordinator has no row.

## Milestone 1 proof

Create the authorized private synthetic repository and its own T3 project when
the engine is ready to run. The service checks the fixture repository's fetch
and push remotes and the native project's registered checkout before dispatch.
One process holds the engine profile's write lock. Use
a real guarded merge and verify task state, exact heads, T3 turn settlement,
merge commit and worktree disposition by hand with the planner.
