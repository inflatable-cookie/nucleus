# Spec 069 — A scheduler that scales with active work

Status: approved (Tom, 2026-11-22: "Yes, but maybe do it with subagents rather than dispatching on nucleus, get it done asap"). Built as direct PRs, batch by batch, with an independent review of each.
Builds on [Spec 066](066-one-reconciler.md), [Spec 067](067-explicit-resolution.md) and [Spec 068](068-self-healing.md).
Audience: queue implementers and reviewers

## Outcome

Tom, 2026-11-22, after the board froze for most of an evening: "adding tasks to
the queue is the most rudimentary of crud actions and should have no effect on
the scheduler until the task becomes active. It shouldn't be bogging down like
this and it points to poor architecture. The scheduler needs rethinking." And:
"This is catastrophic. We need to fix this urgently."

So:

- A queued task costs nothing until it is admitted.
- Host health comes from the host's connection, never from how a pass went.
- The scheduler writes only when something changes.
- Its per-pass cost grows with active work, not with the queue or history.

## What happened

On 2026-11-22 a planner queued about 170 tasks in an hour. From 17:55 to 18:42
Nucleus treated the connected T3 host as unavailable. Every task got a
`host_unavailable` stop, and dispatch stopped. Stop rewrites rose from almost
none to about 5,000 every 10 minutes. The socket to T3 stayed connected the
whole time.

- **The loop.** After dispatching a task, `dispatchTask` declared the host failed
  whenever that task still carried an old host wait (`core/dispatch/dispatch.ts`).
  Every submission runs a dispatch pass (`core/planning/submission.ts` →
  `wakeRepository`). So one stale wait re-opened the outage on every submission,
  and each re-open walked every task on the host and rewrote its stop
  (`core/host/adapter-routing.ts`, `HOST_FAILURE`). The outage cleared five
  minutes after the last submission. nucleus#447 removed this path the same
  evening.
- **The cost.** A pass reads every retained task, including about 1,500 finished
  ones, several times over. It runs a runs-table query per task row, walks every
  task of each offline host, and widens dispatch to most of the queue during an
  outage. Every task write republishes the whole board to every open stream.

The evidence is outside the repository.

## Design

### 1. The queue is inert

- **Submission writes the row and nothing else.** It pushes the task onto the
  existing ordered ready index (`store-queue-index.ts`). It runs no dispatch pass,
  no task quantum, no host read and no wait write.
- **One admitter.** It is event-driven and runs only when one of these happens:
  a slot or in-flight place frees, a prerequisite reaches `done`, a host comes
  online, a hold or pause is released, or a task is submitted while there is free
  capacity. It takes heads from the ordered index in order, with the existing
  fairness rules, and admits as many as capacity allows.
- **A never-started task stores no stops or waits.** Its card works out "waiting
  for a slot · 3 ahead", "waiting for prerequisites" or "waiting for its host"
  from one admission snapshot when the board is read.
- **Remove:**
  - the queued-task loop in the sweep;
  - the `skipped` / `failedTasks` widening of dispatch;
  - the dispatch of unbound tasks on failed hosts.

### 2. Host health is the connection's

- **One owner per host.** A `HostHealth` owner reads the connection's own
  signals: socket state, heartbeat replies and the registry claim. It uses
  hysteresis: a host is down only after the connection is lost or heartbeats fail
  across a short window, and up again on the first healthy reading. Host outages
  are written only on its transitions.
- **A failed or slow call fails only its own step.** No call outcome, pass outcome
  or task record marks a host down. A host whose operations hang shows as
  degraded, and a call that times out is retried by its own owner. Whether a
  degraded host stops new launches is a health rule, decided in one place.
- **Remove:**
  - `auditUnavailableHosts`;
  - the per-task walk in `HOST_FAILURE`;
  - `transportAnswered`;
  - promoting timeouts to host failures in the host pass.

  This supersedes Spec 066 R6 ("the reading is the failure, not the claim") and
  absorbs Spec 067 batch 5 (nucleus#1523).
- **A service start never parks tasks.** Until the new service has read a host's
  health, that host is "unknown", not "down". Tasks keep their state, and nothing
  is written for them.

### 3. Writes only on change

- `hostWait` and `host_unavailable` are worked out from host health when read,
  so an outage costs one write, not one per task.
- **One owner per field.** The task funnel stops clearing a stop implicitly when
  `reason` changes, because two writers alternating made it oscillate.
- Diagnostic meta writes compare first.
- Board publication coalesces to at most one per tick, and the stream sends
  what changed rather than the whole board.

Batch 3 builds all of this except the deltas: the live channel publishes at most
one whole board per 500 ms window. Sending only what changed needs a client
merge protocol and is left for a later change. A host outage's budget pause is
read from the host's own outage record and its closed history, so it needs no
per-task clock.

### 4. Each pass covers only active work

- **Indexed sets.** Passes read indexed sets instead of `store.tasks()`: live
  tasks per host, and active tasks (holding a slot, workspace or run). Finished
  tasks leave the sets when they close out.
- **No per-pass history.** Task rows, thread titles and parent archives cover
  live tasks that have a thread. Catching up on finished threads moves to its own
  slow cursor.
- **No repeated failure walks.** A host known to be offline isn't walked again
  every pass.
- **Host reads come from one snapshot per host per pass**, never from inside a
  task quantum (Spec 068 batch 6, nucleus#1557).

### 5. Simple writes never wait for a sweep

Board writes, CLI calls and submissions run separately from sweep and host work
(nucleus#1545). A slow host or a long pass never blocks them.

### 6. The host's load is bounded by what changed

Measured on 2026-11-22 from T3's own server trace while T3 was heavily loaded:
`orchestration.subscribeThread` ran 14 times a minute at about 9.5 s each, and
about 4 a minute failed. Many targets were thread ids Nucleus derived for
follow-up children T3 never created (`ns-reminder-*`, `ns-checkpoint-*`,
`ns-brief-amendment-*`, `ns-reviewer-report-*`, and `ns-run-<runId>` for a
revision run whose real thread is the retained reviewer). A full shell snapshot
ran about 6 times a minute, and Settings stayed on "loading".

- **One live shell per host.** The T3 adapter holds one
  `orchestration.subscribeShell` subscription per connection and applies T3's own
  live tail (`thread.updated`, `thread.removed`, `project.updated`,
  `project.removed`) to it. Every reader, in a pass or not, answers thread
  existence, archive state, status, pending request and the change marker from
  it. The copy is live only while its tail spoke within five minutes and the
  subscription is under fifteen minutes old; past that, or after a dropped stream,
  `snapshot-required` or an unknown item, the next reader that needs a current
  answer takes exactly one fresh snapshot. The board's live-agent list is served
  the previous copy while that happens; decisions are not.
- **A thread snapshot only when its row moved.** A thread is read only when the
  live shell's row for it changed since the snapshot Nucleus holds, or a reader
  needs what the row cannot carry: a pending question's body, or a running
  thread's projection (its `updatedAt` and timeline, which a stall check reads).
  Either is read at most once per pass. The row keeps T3's item counts, so a new
  item moves it.
- **No read of a thread T3 does not list.** A thread the live shell does not list
  is not live. A follow-up child Nucleus recorded at send time is only a candidate
  until T3 lists it: it costs no read, and it is dropped, not retired, when its
  task ends unseen. A bound thread that left the shell (archived or removed) is
  read once by its exact id, and that answer is kept until T3 names the thread
  again or a command goes to it.
- **Pending questions** are read only for threads the shell marks as awaiting
  input.
- **At most four thread snapshots at once** to one host
  (`T3_THREAD_READ_CONCURRENCY`). Heartbeats are control frames and never queue
  behind them.
- **The UI waits on T3 as little as it can.** Live lists and project
  observations come from the live shell, and the live-agent list is served the
  previous copy while a new one opens. The catalog is one read in flight at a time;
  when T3 takes longer than two seconds the caller gets the last catalog read on
  this connection. The first catalog read and the first shell snapshot on a
  connection are still waited for, and an out-of-pass thread read queues behind
  pass reads at the cap.
- **No archived reads in steady state** (Tom, 2026-11-22: "We shouldn't need to
  be reading archived threads at all"). Archive confirmation trusts the archive
  command's settled receipt (the planner's design for this batch); creation
  lookup, uncertain-delivery settlement and workspace inventories use the live
  shell plus an exact read by id, and a thread the live shell lists is never
  answered absent. The paired
  live and archived inventory and `T3InventoryChurnError` are gone.
- **Retention reads the archived list on its own interval** (Tom, 2026-11-22:
  "Pruning can read archived threads - it needs to know what's there, but that
  shouldn't be running regularly? Once or twice a day?"). The pass runs every
  `threadRetentionIntervalHours` (Settings, 12 by default), detached from the
  sweep, and checks each candidate against the live shell and its own walk
  instead of re-reading the inventory per thread. A walk that fails or is cut
  short is retried after an hour rather than a full interval. T3 has no paged archived read,
  so the walk is one `getArchivedShellSnapshot` per interval and removals stay
  capped at `THREAD_RETENTION_BATCH` per host per pass.

## Safety

These rules stay:

- one writer per task;
- exact-head review and the merge gates;
- unknown delivery is settled, never resent blindly;
- explicit commands keep their warnings.

A host that is really gone still pauses its tasks' launches. The pause comes
from its health owner, once, instead of from every pass.

## What changes in earlier specs

- **Spec 066:** R1's shared observation becomes host health plus one snapshot per
  pass. R3's stale-wait settlement mostly goes. R6 is replaced by §2.
- **Spec 067:** batch 5 (nucleus#1523) folds into batch 2 here.
- **Spec 068:** batch 6 (nucleus#1557) goes ahead as part of §4.

## Batches

Each batch is at most 3 modules and about 1.5k lines. The order puts the most
dangerous behaviour first.

| Batch | Scope | Replaces |
|---|---|---|
| 1 | Inert queue: submission writes the row only; the event-driven admitter; no waits stored on never-started tasks; cards work out queue waits when read. | the queued-task sweep loop, dispatch widening, submission's `wakeRepository` |
| 2 | `HostHealth` per host from connection signals with hysteresis; outages on transitions only; "unknown" at service start; calls fail only their own step. | `auditUnavailableHosts`, the `HOST_FAILURE` walk, `transportAnswered`, timeout promotion; absorbs nucleus#1523 |
| 3 | Writes only on change: host waits worked out when read, one owner per field, meta compared before writing, coalesced board publication. | the funnel's implicit stop clear, per-task outage rewrites |
| 4 | Indexed live and active sets; per-pass work over active tasks only; finished-thread catch-up on its own cursor. | `store.tasks()` scans in the pass |
| 5 | Host load (§6, retargeted 2026-11-22): one live T3 shell per host, snapshot reads only for moved rows, no reads of unlisted threads, a thread-read cap, cached catalogs, no steady-state archived reads, retention on its own interval. | per-pass shell snapshots, out-of-pass snapshot reads, the paired live and archived inventory, `T3InventoryChurnError`, hourly retention |
| 6 | Pass snapshots and reads out of the task lane (nucleus#1557), and simple writes on their own path (nucleus#1545). | — |

**Done when** all of these hold:

- Submitting 200 tasks in ten minutes changes no host state and writes nothing
  beyond the rows themselves.
- A service restart parks no task.
- A pass over a board of 2,000 retained tasks costs the same as over 200 with the
  same active work.
- A steady pass over idle T3 threads sends T3 no request at all, and Nucleus reads
  T3's archived threads only in the scheduled retention pass
  (`test/t3code-host-load.test.ts`).
