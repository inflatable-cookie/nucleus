# 034 Convergence Exit And Next Lane Selection

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Close the current Convergence tranche after the receipt control surface, record
what remains intentionally deferred, and select a non-Convergence next lane.

## Governing Refs

- `docs/roadmaps/g03/033-convergence-local-snap-spawn-receipt-control.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Summarize the Convergence proof surface that now exists.
- [x] Record deferred Convergence effects without turning them into new active
  work.
- [x] Identify the most valuable non-Convergence next lane.
- [x] Keep all Convergence process, backend, provider, raw-output, and task
  mutation effects blocked.

## Execution Plan

- [x] Deferred effects summary batch.
- [x] Exit control closeout batch.
- [x] Non-Convergence lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/115-convergence-deferred-effects-summary.md`
- `batch-cards/116-convergence-exit-control-closeout.md`
- `batch-cards/117-next-non-convergence-lane-selection.md`

## Deferred Effects

Local process effects deferred:

- actual `converge snap` command execution
- process-runner invocation
- raw stdout/stderr retention
- cleanup, cancellation, retry, and recovery execution against a real process

Remote/backend effects deferred:

- object upload
- publication creation
- lane-head sync
- bundle creation, approval, promotion, release, and resolution publication
- any provider write or authoritative task mutation caused by Convergence

Current stopped proof boundary:

- admission, command descriptors, stopped requests, persistence, runner proof,
  sanitized evidence, stopped adapter decisions, replay, execution preflight,
  spawn requests, handoffs, receipts, diagnostics, and receipt control DTOs
  exist as read-only records
- every surface keeps command spawn, actual `converge snap`, raw output,
  object upload, publication, lane sync, provider writes, task mutation,
  callback, interruption, and recovery effects false

## Next Lane Selection

Rejected for now:

- more Convergence runner work, because Convergence is unfinished upstream and
  the stopped proof is sufficient for current adapter planning
- another provider effect lane, because server/front-door pressure should be
  checked first
- proof UI growth, because the current UI remains disposable

Selected next lane:

- `035-post-convergence-health-and-boundary-rebaseline.md`

Reason:

- it moves the project away from Convergence without losing the evidence
- it checks whether the server/provider front door and warning-sized files need
  immediate cleanup before more effect-gated work
- it aligns with the implementation gap index and engine-boundary contract

## Acceptance Criteria

- [x] Convergence has a documented stopped proof boundary.
- [x] Remaining Convergence work is explicitly deferred.
- [x] The next ready lane is not Convergence-specific.
- [x] No command spawn, actual `converge snap`, raw stdout/stderr, object
  upload, publication, lane sync, provider write, task mutation, callback,
  interruption, recovery, or raw output effect is added.
