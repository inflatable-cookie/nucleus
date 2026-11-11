# 009 — Shared telemetry snapshot and metric repair

Status: implemented
Owner: Nucleus telemetry maintainers
Created: 2026-09-15
Governing refs: `docs/knowledge/contracts/durable-telemetry.md`,
`docs/knowledge/specs/005-queue-telemetry.md`

## Problem

Telemetry caches complete filter results. Every cold filter rebuilds every task
through repeated SQLite reads on the plugin event loop. Nine distinct filters
saturated the live plugin and the next RPC timed out after thirty seconds,
although one equivalent derivation from a consistent 48.3 MB backup completed
in about four seconds.

The headline intervention rate also mixes delivery failures, ordinary semantic
review and explicit bulk administration. The first exact cohort therefore shows
71% intervention even though those activities answer different questions.

## Snapshot contract

Build one bounded task-level telemetry base for a durable store revision and a
short age bucket. Load tasks, stage boundaries, runs, hook attempts, notices and
operator events with bounded bulk queries, then derive each task once. Filter,
group and aggregate from that in-memory base.

Telemetry-relevant writes advance a monotonic store revision in the same SQLite
transaction. One in-flight promise coalesces concurrent cold construction. Keep
only the current base and bounded dimension dictionaries; do not retain a cache
per filter. A fifteen-second maximum age refreshes unfinished current-stage age
even when no durable write occurs. Existing records remain readable.

Cold construction must yield often enough that normal Nucleus RPC and lifecycle
work remain responsive. Increasing the client timeout is not a remedy.

## Metric contract

Keep the raw intervention counters and legacy raw rate. Add separate task counts
and rates for:

- delivery exceptions: operational recovery, uncertain or absent creation,
  delivery attention, and operational hook failure;
- semantic review revisions: accepted reviewer or pre-merge findings returned
  to the retained worker;
- operator administration: explicit hold, reprioritize, disposition, cancel,
  supersede, remap and related versioned controls.

Bulk hold, cancellation, supersession and disposition never count as delivery
inefficiency. Hook semantic refusal remains separate from operational hook
failure. Automatic hook replay receives its own raw counter when Spec 010 lands.
Exact, mixed and partial evidence labels remain explicit.

## Performance oracle

Use a deterministic SQLite fixture comparable to the observed store: at least
250 tasks, 50,000 lifecycle facts and enough payload to exercise a roughly
48 MB database. Measure Nucleus process CPU time so host descheduling cannot fail the oracle:

- cold base construction and first aggregate use at most five seconds of CPU;
- fifty warm filter/group requests have p95 CPU time at or below 100 ms;
- while a cold build is active, a normal `queue.ui-snapshot` probe uses
  less than 250 ms of CPU and CPU consumed between event-loop turns has p95 below 100 ms;
- concurrent cold filter requests construct one base.

Tests report the measured values and fail the oracle rather than extending RPC
timeouts.

## UI and compatibility

Show the three headline categories compactly beside completion and raw totals.
Keep existing repository, scope, profile-group, closeout and time filters,
dark theme and compact layouts. Existing clients continue to receive current
fields; new fields are additive and strictly parsed.

## Acceptance oracle

- A durable mutation invalidates the base once; age expiry refreshes unfinished
  tasks without unbounded cache growth.
- Concurrent cold filters share construction and yield to unrelated RPC work.
- Filtering and grouping produce the same exact/mixed/partial values as direct
  derivation.
- Semantic revisions, delivery exceptions and operator administration populate
  only their defined headline category while raw counters remain available.
- Focused performance, RPC, aggregation and rendered-summary tests pass on the
  representative fixture, followed by full Nucleus QA and dark compact inspection.

## Exclusions

No second database, analytics daemon, provider routing change, longer RPC
timeout, title parsing or global task cleanup belongs to this work.
