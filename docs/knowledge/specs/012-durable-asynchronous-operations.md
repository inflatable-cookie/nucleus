# 012 — Durable asynchronous Nucleus operations

Status: implemented
Owner: Nucleus runtime and protocol maintainers
Created: 2026-09-15
Governing refs: `docs/knowledge/contracts/orchestration.md`,
`docs/knowledge/contracts/durable-telemetry.md`,
`docs/knowledge/specs/009-shared-telemetry-snapshot-and-metric-repair.md`

## Problem

Nucleus currently has one process-wide `engine.running` promise. A wake performs a
serial pass across retained tasks and remote observations. Operator controls
wait for that pass through the same control tail, while synchronous SQLite reads,
JSON parsing and UI projections share the Node event loop. A healthy request can
therefore take seconds or time out behind unrelated work.

Marking handlers `async` does not remove the bottleneck. Nucleus needs durable
command acceptance, bounded keyed execution and responsive read projections
without weakening its single-writer and external-effect guarantees.

## Operation contract

Add a generic durable Nucleus operation record with:

- stable caller operation key, operation ID, kind and normalized input digest;
- optional task, expected task version, repository and submission identity;
- `pending`, `running`, `succeeded`, `needs_attention` or `failed` state;
- created, started and settled timestamps, attempt count and bounded diagnostic;
- resulting task ID/version or typed result reference where applicable;
- durable external-effect intent and reconciliation reference when the command
  can cross the process boundary.

Acceptance is one short SQLite transaction. Repeating the same caller key and
input reopens a definitely `failed` operation as `pending` under its existing ID,
keeping its attempt count, so it re-checks current state. A typed refusal raised
before any binding settles `failed` whatever its explanation says; its wording
never makes an operation `needs_attention`. A `succeeded` or
`needs_attention` operation replays its stored outcome without another effect.
A parked restart refused during read-only verification or its rolled-back local
transaction carries a receipt written by the executing service, and so does any
task control refused by another typed pre-send refusal — Nucleus's own
durable-effect fence included. The receipt binds the operation,
input, attempt, service build, intent and unchanged task and run evidence.
An interruption after the receipt leaves the operation in attention without
executing it again. An interruption after the parked boundary starts but before
the receipt also remains in attention, with its original effect evidence intact.
`queue.operation-status` with `reconcilePreSendInputHash`
explicitly settles that occurrence only after the stored identity, effect and
evidence still match and no reviewer delivery is bound to it; a legacy row from
before the receipts existed relabels the same way when its diagnostic is one of
Nucleus's own fence-refusal messages and its journal shows no boundary, retry or
bound delivery. Its original
diagnostic and effect remain history. A definite failure can be retried under
the same key; its receipt and effect are retained before the next attempt.
A missing receipt, a changed task or run, a conflicting effect or an unproved
prior attempt keeps the fence. A present source tree, error wording and missing timeline entries do
not establish what a historical execution did.
A terminal
`retry_effect workspace_archive.<id>` that restart resumes settles from its own
landed archive (2026-10-23). The persisted operation is the identity: a running
`task_control` for that task, at its expected version, whose stored control is
this exact request. The workspace must be in `archivedWorkspaceIds`, and an
event strictly after acceptance must name it (its archive, or its recorded
content discard) and be followed by its archive. Chronology alone never counts,
so an operation never borrows another workspace's or an earlier archive. Archive
events now name their workspace. Nothing is re-enqueued or replayed natively,
and without that proof the stale version still refuses.
Concurrent identical retries reopen a failure once. Reusing the key with
different input fails.
A `needs_attention` operation is not automatically a permanent fence. Later
evidence the task itself recorded answers a creation-class host effect: a
workspace binding event after the control was accepted, then a run created and
used in that workspace, proves the project registration and the thread in it
landed. That operation settles as `succeeded` with its effect `reconciled` and the
evidence recorded on it and in the task timeline, and the shared effect
projection reports it superseded rather than blocking, so no phase waits on an
uncertainty the task has already answered (nucleus#1159). Observation settles;
it never resends. A control whose unknown command has no such artefact in the task
record keeps its fence.
Acceptance returns the operation identity and observed task version without
waiting for an engine pass, provider call, Git operation or hook execution.
Brief-bearing lead checks use the same operation record, fenced by lead ID,
version, digest and repository. Add and edit persist that version first and keep
the operation ID on the lead while the check is pending; the result is recorded
only if the same version is still current.

Expose strict generic RPCs to start and inspect an operation. Adapt native UI,
Nucleus CLI and Nucleus MCP task-control surfaces to start then observe it. Preserve
existing synchronous RPCs during migration; they may wrap the durable operation
only within a short bounded compatibility wait, then return an explicit accepted
operation rather than an unknown timeout. No client may infer failure from a
disconnected response. A reconnect to a still-running service resumes scheduling
without treating its live source promotions as interrupted. A promotion records
its executing process with the running intent. Reconciliation reports no commit
only after that process is proven absent; a live, unreadable or legacy missing
identity stays uncertain. A matching committed source settles successfully even
when the executing process cannot be observed.

Legacy task-control adapters derive their operation key from task ID, action,
expected version and the complete normalized input digest. The digest covers
instructions, hook/PR identity, dependencies and disposition fields. Identical
input therefore resolves one operation after a lost response; corrected input
at the same unchanged task version receives a new deterministic identity. The
readable prefix keeps task, action and expected version, the suffix is the same
normalized digest acceptance fences on, and the generated key stays inside the
200-character caller-key bound: a control whose prefix cannot fit is rejected
before acceptance rather than truncated. This generated-key rule does not
weaken the generic API: an explicitly supplied caller key remains immutable and
rejects a different input digest.

Submission uses its stable submission identity as the idempotency fence. Local
shape checks run before acceptance. Remote repository, origin and pre-dispatch
hook validation run from the durable operation before task insertion, so an
invalid handoff still creates no task while a timed-out client can reconcile the
submission operation safely.

### Reviewer pre-send refusal inspection

A new reviewer continuation marks the execution boundary before calling its
adapter. Read-only local, source, forge and native-observation failures before
that boundary are typed pre-send refusals. After reservation, a local failure or
an adapter result of `sent: false` also settles the reserved delivery as refused.
An adapter exception after invocation remains uncertain, regardless of its
message or error class: the adapter alone knows whether it entered native send.
Existing same-intent uncertain-delivery inspection stays outside the new-send
classification and still requires exact delivery evidence.

The `operation-status` reconciliation of historical direct continuation
operations was deleted on 2026-10-19 (round 4), with the action it reconciled;
no such operation was left unsettled. An uncertain continuation operation now
settles from exact delivery evidence: the reviewer's own callback, or the exact
message in its timeline, settles the delivery and the operations that reserved or
inspected it, by the delivery's identity. The RPC catalogue still classifies
`operation-status` as mutating. A reported, different reviewer mode or thinking
level still refuses; an unreported one is unknown, not changed (see the
[orchestration contract](../contracts/orchestration.md)).

## Scheduler contract

Replace the monolithic full-pass lock with keyed work lanes:

- one active lifecycle quantum per task;
- one integration-effect quantum per repository;
- existing global, project and provider capacity gates for dispatched work;
- one short single-writer transaction at a time, with no awaited remote effect
  inside it.

A quantum performs one bounded reconciliation step, persists its next intent or
deadline, then yields. Durable changes enqueue only affected task, repository,
notice, operation or retention work. Timers enqueue due work. A chunked periodic
audit remains a restart and missed-signal fallback; it never monopolizes the
event loop or serially awaits every retained task in one request path.

Independent task lanes may await remote effects concurrently. Repository Git and
hook publication remain FIFO and exclusive. Every remote action keeps the
existing persist-intent, execute, observe and reconcile sequence. Cancellation,
exact-head checks, callback authentication and unknown-delivery rules remain
unchanged.

`Engine.quiesce()` resolves when active and queued lane work is idle **and**
every already-accepted lifecycle follow-up has either enqueued its quantum or
no-op'd (stop, pause, missing task, dispatch fence). Follow-ups those quanta
legitimately schedule are part of the same wait. A call from inside a lane
ignores that lane so the current quantum cannot deadlock on itself. The
boundary is not a global writer lock, not a guarantee against future external
callbacks, and not proof of external run settlement. Title and cleanup
projections remain on `wake()`'s projection drain. `stop()` uses this wait so
teardown cannot race a follow-up that was accepted before the last quantum
returned. Prompt callback and control acceptance, per-task serialization and
normal background progress are unchanged: quiesce does not start extra fleet
work. Tests that must inspect a hold or mutate fixture Git before the
follow-up retry pause after the first quantum (`wakeTask`, then `paused`,
then `quiesce`); `wake()` remains the completed boundary. A test that walks
the lifecycle one step at a time, inspects an intermediate phase, or changes a
gate, review evidence or agent state before the next step uses
`stepEngine(engine)` (`test/support/engine-step.ts`): one sweep with the
follow-ups it schedules dropped, so the next step starts from the sweep.
World changes a step depends on are made before the report that drains into
it, never after.

Repeated reviewer checkpoint fixtures await `quiesce()` after the receipt and
before reading the task version for an explicit continuation. Delivery changes
the task reason and clears its recorded stop; the checkpoint's scheduled
lifecycle pass restores the operator-needed stop and advances the version.
Reading authorization before that pass can legitimately produce a stale-version
refusal. `test/review-continuation.cases.ts` holds the lifecycle at `advance` to
prove both the early-read refusal and the settled two-checkpoint path. It keeps
the refused operation diagnostic and checkpoint/wait event ordering visible.
This fixture boundary grants no continuation authority and does not refresh or
retry stale controls.

### Task slot occupancy (Tom, 2026-10-01)

A task in `needs_attention`, `awaiting_review`, `changes_requested` or
`verifying` is parked when it has no unreleased run, active recovery or merge
intent. A parked task keeps its workspace and branch but holds neither a
project nor a global task slot. `working`, `dispatching`, `reviewing`,
`merging`, `syncing` and `closing` keep their slots; any unreleased run or
active recovery does too.

When a parked task needs a new run, it competes for capacity with queued work
using queue priority and age. Nucleus accepts operator controls immediately,
then leaves the task waiting with `Waiting for a project slot…` until its run
can be reserved within both limits. The board and task detail identify parked
tasks, and the global slot count excludes them. This follows Tom's accepted
parking ruling for task #139 (2026-10-01: “yes brief parking”).

A current dispatch hold, owner stop, planner wait, delegated-question wait or
budget pause is not a slot request: it cannot rank ahead of work that can
launch. A live unreleased run still keeps its slot until settled. When the
fence clears, the task rejoins by its original age and priority.

### Lane concurrency and long work (Tom, 2026-09-27)

At most N lane quanta run at once across the service. N was a constant (2), meant
to keep Nucleus's outbound work below Paseo's interactive request capacity when
every quantum was a short RPC or Git call. Project validation broke that
assumption: one `effigy ci:fresh` run held a slot for 10–20 minutes, and accepted
submissions from other projects waited behind it (2026-09-27).

- **No global lane cap** (Tom, 2026-09-27). Lanes are ordered queues; waiting on
  one costs nothing, and a blanket cap starves unrelated work. One active quantum
  per task and per repository stays, because that is what prevents races.
- **Bound the real resources instead.** Concurrent calls to the Paseo daemon are
  bounded where they are made (an operator setting in the Settings view, default
  sized to Paseo's interactive capacity), and so are concurrently spawned processes
  (Git, hooks). Work waiting for one of those waits there, not for a lane slot.
- **Long work runs off the lanes.** Project validation (and any program run that
  can outlast a short step) runs as a durable background execution: the quantum
  records its intent and returns, the process runs outside the lane budget, and
  its completion enqueues the task's next quantum. A detached validation
  supervisor writes a durable result before Nucleus reconciles it. If a run has no
  result, Nucleus records it lost only after proving its process group and
  descendants are gone; otherwise it stays held for operator reconciliation.
  Nucleus also stops a validation supervisor whose heartbeat is stale, then uses
  the same process-death proof before recording the run lost; the shared
  supervisor rule is in [Spec 035](035-host-run-scheduler.md). Lost and timed-out
  validations never retry automatically.
- Controls and operations never wait behind a long run.

## Read path and backpressure

Use the store revision and shared projection work from Spec 009 to invalidate
compact Nucleus snapshots. Detail reads remain bounded to one task. Heavy aggregate
construction never runs synchronously in a mutation handler.

When pending work reaches a configured bound, Nucleus returns a typed
`backpressured` acceptance result with retry guidance or rejects before storing
an unserviceable operation. It does not leave the caller waiting until transport
timeout. Task and operation detail expose queued, running and attention state.

## Responsiveness oracle

On a deterministic fixture with 250 tasks, 50,000 lifecycle facts, 32 active
task lanes and delayed provider/Git fakes, measure Nucleus process CPU time
so host descheduling cannot fail the oracle:

- durable control acceptance has p95 CPU time at or below 100 ms;
- operation-status and compact UI snapshot reads have p95 at or below 100 ms;
- an unrelated task control uses at most 150 ms of CPU while another repository
  has a five-second remote effect;
- same-task controls and same-repository integration effects remain ordered;
- CPU consumed between event-loop turns has p95 below 100 ms during the workload;
- restart reconciles accepted and running operations exactly once.

The fixture also covers saturation and proves a typed backpressure response
instead of a thirty-second timeout. These limits may not be met by lengthening
client timeouts.

## Compatibility and rollout

Migrate in stages inside one reviewed change: add operation storage and RPCs,
route operator controls and submission, then replace global passes with keyed
quanta. Keep the old periodic scan as a bounded audit until restart tests prove
the new scheduler. Stored tasks, runs, hooks, notices, receipts and settings are
unchanged; operation records are additive.

Reload only the plugin after full typecheck and QA. Preserve pause state and live
identities. On reload, bootstrap lanes from unfinished durable facts without
reissuing an uncertain effect.

## Acceptance oracle

- Slow work in one task or repository does not delay acceptance or reads for an
  unrelated task.
- Same-task versioned controls remain ordered and stale versions fail before
  effect.
- Submission timeout/retry resolves one validation operation and at most one
  task.
- Unknown provider, Git, hook and notification delivery keeps its prior durable
  reconciliation semantics.
- Restart, duplicate client request and lost response create no duplicate turn,
  PR, merge, hook, notice, disposition or task.
- A failed legacy control does not reserve the task/action/version namespace:
  corrected input receives a distinct operation, while byte-equivalent input
  resolves the original operation and explicit-key conflicts still fail closed.
- An admission gate that runs inside its own executing operation excludes only
  that exact internally verified enclosing operation (kind, task, action,
  version, payload and running state re-proven on every check) from its
  unresolved-effect guard; no caller input can name the enclosure and every
  foreign, pending, running, uncertain (`needs_attention`) or mismatched effect stays fenced.
- UI, CLI and MCP cover every migrated interaction and expose operation status.
- Pause, limits, provider independence and per-repository FIFO behavior remain
  exact.

## Exclusions

No second daemon/database, direct live-database rewrite, relaxed safety gate,
provider-weight change, increased concurrency limit, longer timeout, task cleanup
or Paseo restart belongs to this work.
