# 086 Durable Live Evidence Task Work Linkage

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Link durable live provider-write evidence into task work progress without
automatically completing tasks or accepting reviews.

## Governing Refs

- `docs/roadmaps/g02/085-durable-codex-live-provider-write-execution.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Convert reconciled live provider-write evidence into task work progress
      candidates.
- [x] Persist task-work runtime observations by reference only.
- [x] Surface review readiness without auto-acceptance.
- [x] Expose diagnostics/read-model state for clients.
- [x] Keep callback, cancellation, resume, SCM, and review authority gated.

## Execution Plan

- [x] Evidence-to-work candidate batch.
- [x] Runtime observation persistence batch.
- [x] Review readiness batch.
- [x] Diagnostics/read-model batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/394-live-provider-evidence-work-candidates.md`
- `batch-cards/395-live-provider-evidence-work-observations.md`
- `batch-cards/396-live-provider-evidence-review-readiness.md`
- `batch-cards/397-live-provider-evidence-diagnostics.md`
- `batch-cards/398-live-provider-evidence-task-linkage-closeout.md`

## Acceptance Criteria

- [x] Reconciled provider-write evidence can create task work progress
      candidates.
- [x] Runtime observation records reference receipts/outcomes without raw
      provider material.
- [x] Review readiness is visible but requires explicit operator action.
- [x] Client diagnostics can inspect the linkage.
- [x] Broad runtime authority remains gated.
