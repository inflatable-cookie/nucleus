# 031 — Machine-wide heavy-validation budget: Queue's side (retired)

Retired: 2026-10-02. Queue retired its joins to Effigy's legacy lease store after
the contract 010 scheduler became Effigy's default. Queue now owns run liveness,
capacity waits and validation telemetry through Spec 035; Effigy's
`EFFIGY_HOST_SCHEDULER=0` rollback remains safe while its legacy store exists.
This file is retained as the historical design.

Status at retirement: implemented on Queue's side; depended on effigy#036
(Effigy contract 049) for the then-live installed Effigy.
Owner: Queue runtime and UI maintainers
Created: 2026-09-28
Decision owner: Tom ("Go for it", Project-a thread, 2026-09-28, relayed)
Governing refs: [Spec 022 project validation](../022-queue-projects-without-manifests.md),
[Spec 012 lanes](../012-durable-asynchronous-operations.md), Effigy contract 049
"Heavy-validation admission" (effigy 2989165b5; Effigy owns the mechanism), Project-a's scoped-QA batch (same telemetry vocabulary)

## Direction change (Tom, 2026-09-30)

"The QA lease we added to Effigy should have been a Queue feature - Effigy should
be the runtime that executes QA, Queue and Nucleus should manage who runs what
when." Admission (who runs a heavy QA run, when, and under which budget) moves
out of Effigy into a scheduler that Queue and Nucleus both implement against one
shared contract. Effigy stays the runtime that executes the run. Once the new
scheduler is live, Effigy's lease store is removed. Until then this spec
describes the current, Effigy-owned mechanism. Trigger: on 2026-09-30 Queue
SIGKILLed a timed-out milestone QA run, and Effigy's lease stayed
`stale_owner_unknown` with 9 CPU reserved, because the process owner and the
admission owner were different systems.

The shared contract is Nucleus contract 010 "Host run scheduling" (nucleus
`c5591ac`), and Queue's side is [Spec 035](../035-host-run-scheduler.md). Tom
ruled on 2026-09-30 that heavy runs fail closed when the scheduler is
unreachable; light runs still execute and an operator override is recorded.

## Problem

Heavy QA (`effigy qa`, `ci`, `ci:fresh`) runs unbounded across projects. On
2026-09-27/28 the host sat at load 30–84 on 18 cores. Timing oracles went
inconclusive, Paseo calls slowed until Queue's breaker tripped, and workers' QA
runs contended with Queue's project validation. Queue can't see or bound runs a
worker starts in its own worktree, so the budget is enforced where every run
passes: Effigy.

## Ownership

- **Effigy** owns machine-wide admission for heavy runs: leases, configurable
  measured capacity with interactive headroom, fair scheduling, same-input
  deduplication (only with complete input identity), crash and cancel lease
  recovery, and per-run telemetry (queued, admitted, started, ended, queue wait,
  wall, CPU).
- **Queue** routes its own validations through that admission, records and shows
  its telemetry, and makes sure capacity waits are never mistaken for failures or
  hangs.

## Outcome (Queue)

- **Caller identity:** project validation (Spec 022) runs Effigy with
  `EFFIGY_CALLER=queue:<taskId>:<runId>`, and reads `effigy admission runs --caller
  <identity> --json` and `effigy admission run <id> --json` to join Effigy's records
  to Queue's.
- **Telemetry:** each validation result records Effigy's queue wait, wall time
  and CPU user/system, separately. Task detail shows them. Telemetry aggregates
  queue wait separately from run time per project and task type. Words match
  Project-a's batch: *queue wait*, *wall*, *CPU*.
- **State:** while admission holds a validation, the task reads "Waiting for QA
  capacity (position N)" from Effigy's status, not "running" or a stall. Liveness
  (silent-worker detection, missing-callback timing) treats an Effigy admission
  wait, for Queue's validation or a worker's own `effigy qa`, as alive. A worker's run
  is recognised in `effigy admission status --json` by its repository or worktree
  path, since workers don't set a caller identity.
- **Slots:** heavy validations stay off Queue's worker slots and lanes (Spec 012,
  #074). No global agent count or slot limit changes as a substitute.
- **Workers:** worker and revision prompts say that `effigy qa` may wait for
  machine capacity, that waiting isn't a hang, and not to kill or retry it.
- **Semantics:** coverage, gates, run timeouts and failure meaning are unchanged.
  A capacity wait has its own bounded deadline (Effigy's, 30 minutes by default
  and configured separately from execution timeouts); Effigy's capacity-timeout
  error becomes a typed "capacity unavailable" hold on the task, never a
  validation failure. Null metrics mean unavailable, never zero.
- **Process groups:** each validation command starts in its own process group.
  Queue records the group's id and a random start identity inherited by its
  leader and descendants. Before signaling, Queue proves that a live member of
  that group still carries the recorded identity; unreadable or mismatched
  identity means no signal. A timeout sends SIGTERM to the group, waits the
  configured `terminationGraceMs` (default 30 seconds), then sends SIGKILL if
  the group remains. The result records the signal sent and whether the group
  became empty. This lets Effigy release its admission lease and proves which
  process group Queue stopped. Output-limit termination uses the same path.
- **Shared executor:** milestone QA and repository hook programs use the same
  executor and process-group termination. Repository hook runs use the 30-second
  default; validation and QA repository settings may set `terminationGraceMs`.
- **Not here:** cross-worktree result caching, GitHub workflows, external
  runners, and #091's load-sensitive test fixes.

## Acceptance

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Validation admitted immediately | Result records queue wait ≈ 0, wall and CPU from Effigy's record joined by caller identity |
| 2 | Validation waits behind other heavy runs | Task reads "Waiting for QA capacity (position N)"; no stall or liveness alarm; queue wait recorded separately |
| 3 | A worker's own `effigy qa` waits for capacity | No silent-worker or missing-callback alarm while Effigy reports it waiting |
| 4 | Capacity wait deadline lapses | Typed "capacity unavailable" hold; validation not marked failed; retry by operator |
| 5 | Validation fails its checks after admission | Same failure semantics as today |
| 6 | Telemetry view | Queue wait, wall and CPU reported separately per project and task type |
| 7 | Effigy without admission support (older install) | Queue runs as today and records "admission unavailable", no false telemetry |
