# Durable telemetry contract


Nucleus telemetry describes generic lifecycle facts. It does not infer work type,
document structure, project vocabulary or success from task titles.

## Time semantics

- All stored boundaries use Nucleus's UTC ISO timestamp at the committed state
  transition. An interval is half-open: stage entry through the next stage
  entry. Total elapsed is `createdAt` through `finishedAt`, or query time for an
  unfinished task. Current-stage age is query time minus the latest boundary.
- The mutually exclusive stages are prerequisite wait, held wait, capacity
  wait, workspace and agent creation, worker active, worker release wait,
  review wait, review, verification, merge, synchronization, closeout, attention/recovery,
  complete and cancelled. Waiting, active and intervention totals sum only
  these mutually exclusive intervals.
- Repository-hook time is a supplemental nested measure from durable hook
  execution start through result, failure or uncertainty for each attempt. It
  does not add to active time a second time. Older occurrences without exact
  execution-start events use the available occurrence boundaries and remain
  partial.
- Every new task begins with an exact `telemetry_stage` event. Store updates
  append a boundary whenever the derived stage changes, including reason or
  completion changes that distinguish prerequisite, capacity and worker
  release waits without changing the task phase.
- Records from before stage instrumentation remain readable. Their boundaries
  are reconstructed only from existing events and are marked `partial`.
  A task spanning reconstructed and exact boundaries is `mixed`. Nucleus never
  labels inferred historical timing exact.
- `awaiting_review` records `review_wait` as waiting time; `reviewing` records
  `review` as active time. Their transition records a boundary. Existing stage
  events keep their original meaning and are never rewritten.

## Intervention facts

Per-task counters report recovery runs by target role, affected provider and
profile group, terminal run status and a closed normalized cause family. New recovery intent stores the target role
and incident text before coordinator creation; older runs use partial event
reconstruction. Provider attribution follows the exact affected run, or the
latest run for that lifecycle role when historical recovery evidence lacks a
run identity. It does not credit reviewer or closeout faults to the task's
worker provider. Counters also report uncertain and proved-absent creation,
attention notices, escalation, required hook holds, hook retries, automatic
exact-identity hook replays, revision runs, replacements and operator
controls. Operator controls are
counted only from the explicit `operator_control` event recorded after a
successful versioned control. Older promotion, dependency and disposition
events count only when their detail identifies `operator control`.

Normalized causes are generic: provider unavailable, workspace state,
uncertain delivery, missing callback, repository identity, hook failure,
scheduling and other. Counters may overlap because one operator repair may
also create a revision or hook retry. Intervention rate is the share of tasks
with at least one such fact, rather than a sum presented as unique incidents.

Each incident stores its normalized cause at creation, together with task,
lifecycle role, run, attempt and status. New incidents are counted exactly
from durable incident events by distinct identity; records from before
incident instrumentation remain partial under the legacy counters.

Revision runs record their cause. Ordinary changes_required findings
returning to the retained worker are semantic review revisions; an explicit
pass-gate publication continuation is counted separately and does not spend the
semantic revision budget; recovery, operator-instruction and identity-repair
revisions are administrative recovery. Runs recorded before the cause marker
reconstruct partially.

Bounded worker checkpoint receipts and continuation turns are recorded as two
raw counters. Their time remains worker active time; they never increment
recovery, semantic-revision or operator-administration rates.

Automatic exact-identity hook replays are one raw counter derived from the
durable replay lineage each fresh occurrence carries. They count separately
from coordinator recovery, operator hook retry and semantic hook refusal, and
the retention of the superseded occurrence keeps the old-to-new lineage
visible in task hook history.

The legacy intervention rate counts every overlapping intervention fact and
stays available unchanged. Headline categories classify those facts instead of
summing them:

- delivery exceptions: operational recovery, uncertain or absent creation,
  delivery attention and operational hook failure;
- semantic review revisions: accepted reviewer or pre-merge findings returned
  to the retained worker;
- operator administration: explicit hold, reprioritize, disposition, cancel,
  supersede, remap and related versioned controls.

Each category reports the tasks carrying at least one fact of its class, the
fact total and that task share of the group. Bulk hold, cancellation,
supersession and disposition never count as delivery inefficiency. Hook
semantic refusal stays separate from operational hook failure. A task may
appear in more than one category because the classes are defined per fact, and
no aggregation adds them together into one number.

## Reviewer calibration

For every reviewer run whose completion records `ready_to_merge` or
`changes_required`, telemetry correlates the verdict and its exact head with
the reviewer agent, profile, provider, model and profile group stored on the
run. Each later fact attributes to the latest verdict recorded at or before
its time: semantic or pre-merge revision rounds, the accepted independent
re-review that resolves a round, exact-head pre-merge refusals after
`ready_to_merge`, and post-merge incidents deduplicated by incident identity
after the first merge-verified boundary. Only stored routing dimensions and
task scope are used; nothing is inferred from repository names, titles,
summaries or prose.

A verdict without a stored reviewer profile keeps its verdict count but is
partial: it never enters per-reviewer rows, exact-head denominators, any
attributed fact row or any rate. Revision rounds without a stored cause marker
stay partial rounds and are never guessed into a cause family. A round
resolves only when the next recorded verdict after the round is an accepted
re-review; a later approval that follows a further blocking verdict never
resolves it retroactively. Post-merge incidents split by
the stored normalized cause: the work-identity family (branch, head, pull
request and merge conflicts) reports as semantic, every other family as
operational.

Every signal exposes its underlying counts. Rates are distinct-verdict shares
over exact-head evidence only, so they can never exceed one: the
revision-return rate is the share of exact verdicts that received at least
one attributed revision round, the refusal rate is the share of exact
approved verdicts refused at the exact head, and the resolution rate is the
share of exact-attributed rounds resolved by the next accepted re-review.
These are calibration signals, never reviewer scores, quality rankings or
causal claims, and per-reviewer rows stay counts only. A group without
verdicts reports partial calibration evidence.

`queue.telemetry` gains additive reviewer-dimension filters — reviewer
provider, reviewer profile and reviewer profile group — kept separate from
worker profile-group and incident-provider filters. They match tasks whose
reviewer verdicts carry the requested dimension, and the snapshot exposes the
observed reviewer dimension dictionaries. The reviewer-profile filter resolves
the same identity the dictionary advertises: profile name, then agent id,
then profile id, with an unattributed fallback for identity-less verdicts.
The snapshot also carries the
shadow-review experiment plan from Spec 011 as a constant disabled record:
non-authoritative, read-only, one shadow per sampled task, a daily cap no
greater than five and a sample rate no greater than ten percent. Eligibility
and the fixed start and end are deferred: they are defined only when an
operator authorizes a named experiment. No runtime,
dispatch or enablement exists in telemetry; turning any experiment on
requires a separate operator decision and versioned control.

## Usage (Spec 058 slice 1, shadow)

Usage is observation only. It changes no budget, pause, refusal or routing.

- Source: a push stream on each unreleased run's agent (Paseo timeline
  subscription), opened and closed on the existing sweep tick. Nucleus polls
  nothing for usage. The stream carries each turn's own usage on
  `turn_completed`. The agent snapshot's `lastUsage` is last turn only, so it is
  never summed.
- Recorded per run as additive `usage` on the run row: turns, reported turns,
  uncached input, cached input, output, observed wall time, peak context-window
  occupancy and a partial flag. Turn wall time runs from a turn's start to its
  terminal event as Nucleus receives them. A turn counts once per turn id.
- A provider that reports no tokens for a turn adds a turn and its wall time,
  never a token count. Effective tokens = uncached input + output + 10% of
  cached input, rounded to a whole token, and only over reported turns.
- Partial, never zero, when Nucleus cannot see a gap: a restored or replaced
  stream, a stream the daemon released or failed to establish, a turn whose
  start Nucleus did not observe, a run dispatched before this process started, or
  a failed write. A turn that both starts and ends between two sweep ticks,
  before its stream opens, is not seen at all.
- `queue.detail` carries `telemetry.usage`: task total, per-role totals (worker,
  reviewer, recovery, verification, closeout) and evidence (`exact`, `partial`,
  `none`). A run replaced mid-task is a separate run, so the task sums both.
- `queue.telemetry` carries `usageByComplexity`: per complexity over the matching
  finished tasks, nearest-rank p50/p95 of effective tokens (reported tasks only),
  observed wall time and turns, with partial counts. Tasks with no usage count as
  partial and stay out of the samples.
- Effective tokens wait for Paseo to report per-turn usage on a provider. Claude
  turns carry it (confirmed 2026-11-01 on a live run). Other providers show turns
  and wall time until their turn events carry counts.

## Aggregation

`queue.telemetry` accepts a time window, an optional exact `createdAfter`
cohort boundary, and optional exact repository, scope, worker
profile-group, closeout-authority, intervention-role and intervention-provider
filters, plus the reviewer-dimension filters described above. The cohort boundary is an ISO timestamp with timezone and includes
tasks created at or after it. Intervention filters match role-attributed
recovery or incident facts. It groups by none,
repository, scope, profile group or closeout authority. Each group returns
closeout-authority counts, task and completed counts, completion and
intervention rates, the headline category counts and rates, p50 and p95
total/waiting/active distributions, per-stage
distributions, evidence quality and aggregated intervention counters.

Telemetry derives one bounded task-level base snapshot for the whole store
rather than one derivation per filter. Tasks, stage boundaries, runs, hook
attempts, notices and operator events load through bounded bulk reads, each
task derives once, and filtering, grouping and percentiles then run in memory
over that base. A telemetry-relevant write advances a monotonic store revision
in the same SQLite transaction; one in-flight promise coalesces concurrent cold
construction, and a fifteen-second maximum age refreshes unfinished
current-stage age even when no durable write occurs. Only the current base and
bounded dimension dictionaries are retained, so memory does not grow with
filter cardinality. Cold construction yields often enough that normal Nucleus RPC
and lifecycle work stay responsive; raising a client timeout is not a remedy.

Windows select tasks by creation time. Percentiles use nearest rank over the
retained matching records. Empty samples return null percentiles. Every
distribution reports its sample and partial-evidence counts. Nucleus's existing
4-day terminal-history retention (Spec 018; Tom, 2026-10-20) still applies, so a wider requested window
does not claim records that have already expired.

`queue.detail` includes the same task telemetry alongside task, runs, notices,
hooks and recent activity, including observed generic closeout authority. The
native detail modal renders a compact timing
summary. The Telemetry page exposes the aggregate filters and evidence labels, a
compact reviewer-calibration section per group with counts beside rates and
honest partial labels, and the disabled shadow-review plan caption.
The existing SQLite task events, runs, notices and hook outbox remain the only
durable sources; telemetry adds no database, analytics service or repository
protocol.

The shared Settings screen exposes aggregate telemetry in both the Paseo plugin
and the web board. The board header keeps Pause and does not contain a telemetry
control. Settings reads the same `queue.telemetry` RPC; filters and results do
not grant any task or dispatch authority.
