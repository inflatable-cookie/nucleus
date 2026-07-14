# 030 Review Guided Rework Execution

Status: completed
Owner: Tom
Updated: 2026-07-11

## Purpose

Turn a persisted rejected or Needs changes decision into a new, explicitly
authorized task work iteration without adding an agent tool or overwriting the
reviewed evidence.

## Governing Refs

- `../../contracts/023-task-backed-agent-workflow-contract.md`
- `../../architecture/product-workflow-ui-architecture.md`
- `016-selected-task-rework-from-review-outcome.md`
- `029-task-attributed-diff-review.md`

## Goals

- [x] Expose current review outcome, note, and provenance through
  `task_workflow inspect`.
- [x] Admit a new task-scoped rework run only from explicit current operator
  authority and current rejected/Needs changes evidence.
- [x] Give the provider the review note and bounded reference context while
  retaining the prior work item and evidence.
- [x] Produce a fresh work item, checkpoints, diff, and awaiting-review state.
- [x] Keep chat as the primary control and add no new agent tool or permanent
  UI region.

## Execution Plan

- [x] Batch 1: canonical rework-context read and portal inspection.
- [x] Batch 2: rework-run admission, provenance, and provider prompt.
- [x] Batch 3: receipt/Diff iteration refresh and product smoke.
- [x] Batch 4: regression, failure, and authority closeout.

## Boundary

This lane may read the latest selected-task review decision, reuse the existing
rework preparation authority, and run a new task-scoped work item after a new
operator mandate. It may pass the durable review note and opaque evidence refs
to the task provider prompt.

This lane must not send patch bytes automatically, overwrite prior work or
review records, infer execution authority from Needs changes alone, complete
the task, widen Goal-run semantics, add an agent tool, or add a permanent UI
region.

## Acceptance Criteria

- [x] Inspect exposes exactly the current durable review context.
- [x] Rework requires a fresh operator message, expected task revision, and
  idempotency key.
- [x] The new work item cites the reviewed decision, work item, and evidence.
- [x] Provider instructions include the note but no transient patch content.
- [x] A successful rework produces a new independently reviewable diff.
- [x] Duplicate and stale requests do not create another work item.

## Batch Cards

Ready:

- None.

Completed:

- `batch-cards/161-rework-product-loop-and-validation.md`
- `batch-cards/160-rework-run-provenance-and-provider-context.md`
- `batch-cards/159-rework-context-portal-inspection.md`

## Checkpoint

After card 161, stop for operator review before choosing task completion or a
broader Goal rework policy.
