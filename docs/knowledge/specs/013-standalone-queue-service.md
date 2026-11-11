# 013 — Standalone Nucleus service and thin Paseo bridge

Status: implemented
Owner: Nucleus runtime and protocol maintainers
Created: 2026-09-15
Governing refs: `docs/knowledge/contracts/orchestration.md`,
`docs/knowledge/contracts/service-boundary.md`,
`docs/knowledge/specs/012-durable-asynchronous-operations.md`

## Problem

Nucleus's complete stateful runtime is tied to plugin load, reload and RPC
lifecycle. Although Paseo 0.8 runs that backend in a subprocess, the plugin still
owns a 49 MB durable store, nearly ten thousand lines of server/shared runtime,
long-lived callbacks and every orchestration responsibility. Maintenance and
failure handling therefore remain coupled to the bridge deployment.

The operator has selected a persistent service boundary. Paseo internals remain
out of scope; the service must make its own storage, work admission, SDK traffic
and update behavior as smooth and bounded as possible.

## Target processes

The Nucleus service owns SQLite, settings, runner artifacts, durable operations,
task and repository lanes, its Paseo SDK connection, GitHub/Git, hooks,
callbacks, notices, telemetry, health and controlled replacement.

The Paseo plugin retains the native client surface, shared contracts and one
small backend bridge. It imports no engine, Store, Git, hook or routing module
and opens no Nucleus state file.

## Protocol

The service build identity is derived once at load from the installed backend
source files (`server/**`, `shared/**`, `bin/queue-service.mjs`), the RPC method
names, protocol version and declared generation. The bridge uses the same source
root for comparison and refuses to reuse or spawn a service if those files cannot
be read. A backend edit therefore replaces the service on the next reload;
unchanged source reuses it. Documentation, roadmap and client edits leave it
alone. The generation remains available for a manual roll or rollback.

The bridge checks only the configured main channel periodically. After a
successful integration sync of its configured build repository, the service
leaves an advisory roll request for an immediate check. The hint does not
authorize replacement: the bridge builds and verifies the observed main revision,
then uses the bounded drain and replacement path after settle/follower deferrals.
Linked-checkout rolling is retired (Tom, 2026-11-09).
Other repositories cannot request this self-roll. Direct CLI compatibility is
per method: the protocol version and called RPC's input/output digest must
match, even when whole-build identities differ. A protocol mismatch fences the
call; a missing method or changed method digest waits through active roll
progress for a compatible service, up to ten minutes. Failed rolls and
timeouts are explicit. See the [service boundary](../contracts/service-boundary.md)
for the complete compatibility and unknown-outcome rules.

Use length-bounded framed JSON over the owner-only local transport. Each request
contains protocol version, request ID, method and input; each response contains
the same ID and exactly one validated result or typed error. Bound connections,
in-flight requests, idle time and write buffering.

Generate the method catalogue from existing shared RPC contracts. Read methods
may execute concurrently against one revisioned view. Mutations return durable
operation acceptance before remote work. Publish no unauthenticated TCP or
browser endpoint.

The read catalogue is projection-first. `queue.ui-snapshot` remains a compact
initial board response. Follow-up board requests carry the last observed store
revision and receive unchanged or a bounded delta. `queue.detail` reads one
selected task with bounded recent evidence. Telemetry and configuration domains
load only for their active view. The client never calls `queue.snapshot`; retain
that method as a live-fleet compatibility/operator surface until its callers
move to bounded domain reads. Its task list contains non-terminal tasks only;
completed tasks remain addressable through `queue.detail({ taskId })`, including
their closeout record, and through `queue.telemetry` aggregates.

The compatibility `queue.snapshot` task list excludes `handoffText` and terminal
history. Callers may filter by `repository` and `project` and page with `limit`
(default 100, maximum 250) and a stable `cursor`. A consumer that needs a
selected task's handoff calls `queue.detail({ taskId })`; terminal history is
`queue.outcome-search`. The live task projection no longer grows with completed
history, and a single page cannot grow with the whole live fleet. An oversized
response receives a small typed `oversize` error with its method, refused byte
count and frame ceiling before the service closes the connection. The service
also writes the latest method and byte count to the owner-only
`oversize-response.json` record in its data directory. The CLI reports the
method, response size and ceiling from that error.
On a 2026-09-20 consistent copy of the current store (1,662 retained tasks), the
record measured the old response at 20,581,546 bytes. The revised response
served twice at 15,169,664 bytes with a 36-character request ID, leaving
1,607,552 bytes (9.6%) below the unchanged 16,777,216-byte ceiling. Service
build 36 rolls this response change.

The later live-fleet projection measured 467,352 compact bytes with 64 live
tasks across two projects at the configured slot maximum, before and after
3,000 completed records were added. The terminal records remain in SQLite and
`queue.detail` returns them with completion data. The normal live task payload
therefore does not follow terminal history; the existing 16 MiB refusal still
guards an individually oversized live field. Queued tasks are not slot counted,
so this is a history-independence claim, not an unconditional byte ceiling for
arbitrary pending submissions.

Other read surfaces: the native board uses compact summaries and an unchanged
revision acknowledgement; terminal rows appear only for unresolved routing or
side effects. Detail is addressed by task ID and caps recent evidence rows.
Bulk disposition detail is addressed by operation ID and input batches cap at
256 items. Runner snapshots reflect the operator-controlled runner registry,
not task history. Telemetry returns aggregate data, caps group rows, reviewer
rows per group and filter values at 100 each, and reports omitted rows. An
ungrouped query still counts every matching completed task; `repoPath` obtains
an exact repository cohort.

## First cutover

1. Extract runtime construction from module globals into an explicit owner with
   start, health, drain and stop phases.
2. Add service server/client transport around the existing contracts.
3. Prove every registered RPC against in-process and service transports using
   the same copied store and fake external adapters.
4. Add a service executable and owner-only bootstrap files under the current
   data directory. Preserve callback and helper paths.
5. Replace `index.server.ts` with forwarding-only handlers. First reload lets
   the old backend stop and release SQLite before the bridge ensures the service.
6. Before scheduler wake, verify exact task counts and versions, pause state,
   operations, runs, notices, profiles, runner revisions and host identity.
7. Provide bounded update and rollback commands that prove drain and lease
   release. Never retry an uncertain spawn or ownership transfer blindly.

The boundary cutover changes no live database schema.

## Asynchronous persistence

After cutover parity, move `DatabaseSync` and full record validation into one
worker thread or equivalent service-local executor. Convert Store consumers by
bounded domain seams; never mix unsynchronized owners. Keep revisioned board and
telemetry projections in service memory and rebuild before readiness.

The request loop performs no full-history parse or SQLite scan. Saturation
returns typed backpressure. Public RPCs and durable record shapes stay fixed.

### Implemented seam

`service/executor/executor.ts` and `service/executor/executor-worker.ts` own the
service-local persistence executor: one worker thread inside the standalone
service builds the same `QueueRuntime` the legacy in-process backend used and
is the single owner of `DatabaseSync`, every record validation and the full
engine (Paseo adapter, callbacks, runners, lanes). The request loop never
touches SQLite: `QueueService` forwards catalogue methods to the executor as
promises with bounded in-flight (`ExecutorError`/typed `busy` backpressure at
the executor bound), and the worker applies store work in submission order
with one short serialized transaction per mutation.

`service.health` and `queue.ui-snapshot` are answered from executor-pushed
in-memory snapshots instead of awaiting the executor. The worker publishes
health plus the revisioned compact board projection whenever the store
revision advances — always before it replies to the request that caused the
change — and refreshes health once a second so time-derived counters and
connection state settle without a durable change. A delayed database
operation inside the executor therefore cannot delay health or a cached board
read, while a fresh board read for a new revision awaits the executor and
reflects exactly the durable state at or after its commit.

Exactly one writable owner is preserved: the executor worker holds the
durable `processOwner` lease inside the service process, drain forwards into
`RuntimeOwner.drain()` under a bounded release guard, and a lost executor
fails closed instead of leaving the store owned by a dead thread.

### Write boundary and executor faults (2026-10-12)

Tom's ruling, 2026-10-12: "Can you look into why the executor stopped and
hardening against this sort of issue. Seems like a lack of validation made this
problem for us?" This section is the hardening under lead
`6a84e627-9a30-4507-9e62-3d8c81a96057`.

Historical cause is unproven. The 2026-10-12 read-only assessment saw native
reads refuse `Persistence executor is gone` while the service pid stayed alive
and cached health still reported ready. No exit cause was retained in service
health or plugin logs. Two code paths could end the worker: an uncaught throw in
the one-second snapshot timer, and an unexpected worker exit that was not
classified as a loss. Neither is established as the cause of that outage. The
saved external-merge reason above 4000 characters was a separate read-bound
mismatch, fixed by PR 417; nothing observed ties it to the executor death. Future diagnosis reads the retained record
below, not a reconstruction.

- **Write boundary.** Task insert, update and runtime-retirement writes validate
  the complete resultant task against `taskSchema` before the row, events,
  notices or credential commit. A refusal throws inside the write transaction, so
  the whole write rolls back and the prior record, revision and authenticated
  result stay as they were. Stored JSON keeps the record as written. The parsed
  copy is the projected row, so there is still one parse per write. Reads already
  parsed every stored row, so the refusal covers exactly what a cold read would
  refuse. No migration, backfill or production bypass exists.
- **Projection faults.** A snapshot publication that throws in the worker no
  longer ends the worker. It is reported as a bounded `projection` fault. The
  worker keeps serving, and each repeated failure increments a count instead of
  logging again. `service.health` and `queue.ui-snapshot` fail closed with the
  retained cause and never serve a stale snapshot as current. Only a successful
  fresh publication clears the fault. The worker's board cursor advances only
  after the parent has received the board, so a failed post never leaves an
  unchanged acknowledgement pointing at a board the parent does not hold.
- **Post-commit publication failure.** When a request's handler settles but its
  board publication fails, the caller gets an error whose text says the outcome
  is uncertain. The change may already be committed, so the caller must read
  current state. Nucleus never suggests or performs automatic replay.
- **Executor loss.** An unhandled worker error, or any unexpected exit including
  code 0, rejects pending requests promptly. Health and the cached board report
  unavailable with the kind, time, exit code and a bounded message and stack.
  New requests fail closed. The death is written to the owner-only
  `queue-service-executor-fault.json` in the Nucleus data directory, which the
  bridge reads for the live pid that is not answering. A deliberate drain or
  terminate is not a fault and writes no record.
- **Boot.** A worker that errors or exits before its first snapshot rejects
  `start` promptly instead of waiting for the boot timeout.
- **Not done.** No automatic worker respawn, process kill, ownership transfer,
  database reopen, or task or effect replay. A dead executor's service stays up
  and refuses requests until an existing drain or roll replaces it.

## Incremental reconciliation

Tom's 2026-10-08 backlog ruling: short merge effects must not spend minutes
waiting between mechanical lifecycle steps. Each bounded sweep window schedules
independent task lanes concurrently, yielding between starts; actual Paseo and
process admission limits remain authoritative. One task lane remains exclusive.
A completed transition into verification, merge, synchronization or closeout
queues one coalesced follow-up on that task. Changes to merge intent/result or
merged/synchronized identity also count as progress. Unchanged waits and
reason-only changes do not poll themselves; author/reviewer turns are not
continued by this mechanism. When the integration holder yields or finishes,
the next eligible FIFO holder is woken directly. Follow-ups recheck dispatch
fences and the engine-stop settlement hold and use the ordinary authenticated
gate path. Pause still drains existing mechanical work and starts no new run
(orchestration contract). A roll loses only
these scheduling hints: durable intents and the bounded safety sweep reconcile
any missed work without replaying known side effects.

Replace the eager audit wake with durable dirty-lane scheduling. Submission,
callback, control, hook, operation and external-observation events enqueue the
smallest affected task or repository lane. Repeated events coalesce by lane and
revision. Independent lanes may proceed concurrently within explicit bounds;
the same task and repository-write lanes remain serialized.

Paseo adapter calls use their own bounded admission queue. Coalesce agent and
workspace refreshes, suppress already-confirmed workspace titles, and rate-limit
worktree creation, archive and inventory calls. Cache observations for a short
bounded interval, invalidating them on relevant state changes. Durable Nucleus
intent remains the authority when admission is delayed or the service restarts.

The origin pass is the one periodic reader of those caches that used to pay for
its own task selection: it reads both of its task sets as filters over the
in-memory projection instead of SQL scans over every stored task, reads the
delivered completion notice only for the finished tasks that owe their origin a
notice, and shares one workspace Chatterbox inventory across every task that
records that workspace and across passes, until a Paseo lifecycle signal for that
workspace drops it (a failure is never remembered). A missing origin therefore
costs one inventory read per workspace per minute at most, not one per missing
workspace per pass (2026-10-25 performance audit, item A9).

Retain a cursor-based background sweep for restart recovery and missed external
events. It processes bounded batches, yields between them and is pre-emptible by
health, compact reads and operator controls. It must not iterate all historical
tasks or all retained workspaces after every callback.

### Implemented seam

`core/host/admission.ts` owns one `Admission` controller wrapped around the Paseo
adapter (`admitAdapter`). Every outbound call is classified `callback`,
`control`, `observation`, `title`, `cleanup`, `inventory` or `workspace` with a
per-class limit, a six-call total in-flight bound and one global start every 125
milliseconds. Class admission happens before total admission, so a backlog on a
one-wide housekeeping lane cannot reserve global slots. The total scheduler
prefers callbacks and controls over observation, workspace, inventory, title and
cleanup work. Equivalent in-flight work is shared
by identity key, and a settled quiet observation is cached for a short bounded
window that is invalidated by every send, creation, archive, title confirmation
and lifecycle signal. `workspaceAdmission` defers new creation while the breaker
is degraded or the workspace budget matching the current global Dispatch Limits task-slot limit is full; the caller records
durable creation intent only after admission, so a deferral leaves the task
queued and plainly visible. `Admission.snapshot()` reports class depth,
coalescing, per-class p50/p95/max latency, deferral count and breaker state; it is
published in `service.health` and merged into `queue.telemetry` beside the
durable sweep cursor.

`Engine.wakeTask` reconciles one task lane and `Engine.wakeRepository` only that
repository's queued lanes; `Engine.sweepOnce` reconciles one bounded cursor page
and `Engine.wake` drains pages until the durable cursor has covered the fleet
once. Titles are enqueued only from a real phase transition and drain on one
serial title lane, with confirmed titles producing no request and degraded
admission deferring the rename; terminal archive work drains on one serial,
restart-safe cleanup lane. Neither projection holds the delivery lane pool, so a
slow title or archive cannot starve a callback or control.

`Resolution.lease` proves only the current worker, an assigned coordinator or
reviewer with a recorded live run, unreleased runs and identities named by a
persisted incident or recovery episode. Released historical runs are skipped.
A run whose authenticated completion is already recorded is finished work
(nucleus#1100): its agent is not a live participant a new dispatch waits on,
whatever release bookkeeping still pends on the run row. What remains uncertain
about it — a durable delivery or effect, an episode's pending action, a
corrected result — is fenced by the paths that record visible waits (the
review-dispatch effect fence in delivery, `runDurableFence` in owner verbs, the
episode's own observation), never by this liveness read. A launch whose lease
declines records a visible wait naming the participant that still owns work,
what the observation shows and the verbs that exit it, and the accepting
restart/move-to-review verbs probe the same lease so their reply names the
fence instead of reporting success while nothing launches.

`shared/lifecycle-signal.ts` defines the bounded hint shape. The bridge forwards
only the eight lifecycle event names with the event's agent/workspace identity;
the service exposes `service.lifecycle-signal`, maps the identity with
`Store.taskIdsForIdentities` (an exact, read-only SQL lookup that materializes no
fleet history) and wakes only those task lanes, returning `{ok, matched}`. An
unknown identity matches nothing.

### Single run identity and ownerless attention

One worker creation mints exactly one run identity. `Engine.launchAgent`
rechecks the launch gate inside the credential-and-intent transaction, using the
durable task rather than the caller's pre-verification snapshot, so a concurrent
launcher for the same creation yields instead of overwriting `task.runId` or
creating a second credential and agent. The durable task, the stored callback
credential and the live `northstar.mcpBinding` ticket therefore name one run by
construction.

Where a retained worker's run identity advances, its binding follows it on the
same path the live session already holds. `sendRun` already re-issued the
ticket; `continueWorker` now does the same for a bounded checkpoint continuation
when the retained label names an earlier run, issuing the fresh credential for
the durable task run only in that rotated case. A matched binding is never
rewritten, so an ordinary continuation does not rotate a credential the running
session already holds. Reuse still requires that path to live under the current
data home: rewriting the current-home ticket does not move the session's argv.
A retained thread whose ticket is outside that home is relaunched on a fresh
thread with the same profile, the same way `route … now` starts a new session.

A read-only diagnostic (`core/intake/reporting-identity.ts`) compares a stopped live
initial-worker task's retained binding run against the durable task run. It
returns the split only for a task with no completion, no PR identity and no
current run and mutates nothing. Reconciliation runs the exact branch-PR
identity check first, so a single open PR still reconciles through the retained
revision path that re-issues the binding; the diagnostic reports the remaining
split before the lane stalls.

`Resolution.attention` lands `needs_attention` only for that same ownerless
window. Attention that still holds a live run, such as a reviewer callback
reminder or a repository pre-merge gate, keeps its phase and
carries attention only, so mid-flight review, verification, merge and closeout
transitions are unchanged. A callback-free initial worker landed in attention
keeps one incident identity across the phase transition.

## Update and supervision

- Reuse a compatible service across plugin reloads.
- Drain a detached service if its published identity disappears or names a
  different process. This covers interrupted tests and reload cleanup without
  coupling the production service lifetime to its bridge parent.
- An incompatible build first requests bounded drain and observes socket plus
  lease release before replacement.
- Nucleus's own successful repository sync prompts the bridge's existing source
  check; the periodic digest watch remains the fallback. CLI roll compatibility
  follows the per-method protocol and contract-digest rule above.
- A crash cannot produce a false successful response. Restart reconciles
  accepted operations and uncertain effects from SQLite.
- The bridge may spawn a definitely absent service from the exact installed
  checkout. It does not own its lifetime after readiness or duplicate an
  uncertain spawn. A closed bridge never spawns again: `close()` releases the
  owner, and a later request is refused instead of resurrecting a service; a
  plugin reload builds a fresh bridge. Test suites that spawn fixture services
  track every bridge and its spawned pids from the spawn moment and settle
  them at file end, so a cancelled or failed test cannot leave a detached
  service behind.
- During the bounded startup window, the bridge drains the child's stdout and
  stderr, retaining only a 2,000-byte redacted tail and spawn/exit context. A
  failed startup is atomically recorded in owner-only
  `queue-service-startup-failure.json` and appears in `queue.service-state`;
  failed replacements also retain it in the service-roll detail. The bridge
  keeps draining both streams after readiness without retaining runtime output,
  and clears the failure record when a compatible service answers. The detached
  service ignores EPIPE on those streams after its bridge exits, so later log
  writes cannot stop the service. Command arguments and environment values are
  never recorded.
- Separate bounded logs and timings distinguish bridge, service queue, database
  executor, Paseo SDK and external effect latency.

## First incremental reconciliation tranche

The service becomes locally readable after its callback socket and SQLite owner
are established; daemon connection and restart reconciliation continue in the
background. Authenticated callbacks and helper controls schedule their exact
task lane directly. The full safety sweep runs once per minute rather than on
those callback paths.

Two lifecycle lanes may await unrelated external effects concurrently. A task
lane also owns its single workspace-title projection. Confirmed titles produce
no SDK request; failures retain the same request identity and back off from five
seconds to five minutes. These limits protect Paseo's interactive RPC path while
durable Nucleus work remains pending rather than being dropped.

## Board refresh work

Board refreshes derive slot-wait reasons from one read-only capacity and run
view per durable revision. Dependency checks are shared within that synchronous
projection; launch and controls still read current Store facts at their own
boundaries. Lead and draft lane-activity aggregates are reused until those
records change. Lead/draft writes, imports and transaction rollback invalidate
the aggregate; callers receive their own copy.

A private consistent-store measurement on 2026-10-08 reproduced roughly three
seconds of warm board construction, including 4,802 repeated dependency checks
and a historical lead/draft activity scan. That executor work delayed SDK
response processing and therefore inflated observed Paseo call durations.
Task updates acknowledge the task/run projection's write clock after updating
the maps and before synchronous observer notification. Observers read the new
record inside the transaction without rebuilding the entire retained fleet.
Rollback still discards the projection; writes outside the funnels still
invalidate it through the database clock.

Terminal host-process discovery awaits bounded macOS `ps`/`lsof` commands.
Those commands do not block executor callbacks and reads while the OS scans.
Timeout, partial-output and cwd-failure semantics remain unchanged; target
selection still checks recorded start identities before sending any signal.

QA supervisor polling and read reconciliation also await command-line and
identity-token scans. Unreadable results stay unknown. After each inspection,
the caller checks the retained run still matches its snapshot before mirroring,
settling or reconciling it; a changed run is observed again rather than applying
stale supervision evidence. Detached cleanup and signal identity checks retain
their existing behavior.

Actual daemon workspace lifecycle latency is a separate boundary; reducing
board work does not claim to fix daemon Git or filesystem operations.

## Acceptance oracle

Against a consistent copy of the current roughly 49 MB database:

- bridge startup performs no SQLite, Git, hook or full-state work;
- initial board transfer stays below 128 KiB at the current task volume, and an
  unchanged refresh stays below 2 KiB;
- opening one card fetches no unrelated task, run, hook, notice or event;
- bridge CPU p95 is below 10 ms and adds below 25 ms local latency outside host
  stalls;
- service health and warm board reads have p95 below 100 ms during delayed
  external work and telemetry construction;
- a five-second Nucleus operation does not delay unrelated Paseo RPCs;
- a five-second database fixture does not block the service request loop after
  asynchronous persistence lands;
- one task callback schedules no observation or title work for unrelated tasks;
- a burst of 100 same-task events coalesces to one current-revision lane and a
  bounded number of Paseo observations;
- slow Paseo observations hold within configured concurrency and rate bounds
  while service health, board reads and unrelated task controls remain live;
- the background safety sweep yields between bounded pages and converges exact
  task state after a simulated missed event;
- every existing UI, CLI and MCP RPC passes schema and semantic parity;
- plugin reload retains the service, database owner and exact live identities;
- crash, update, rollback and lost-response fixtures duplicate no external
  effect;
- cutover and rollback each prove one writable SQLite owner;
- full QA and dark native inspection pass without restarting Paseo.

## Exclusions

- No new product database, copied Nucleus state or network listener.
- No task, workspace, profile, notice, limit or runner cleanup.
- No weakened exact-head, authentication, intent, lease or recovery rule.
- No provider routing or concurrency-limit change.
- No Paseo daemon repair or claim that the bridge bypasses a host stall.
