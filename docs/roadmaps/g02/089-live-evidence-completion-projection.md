# 089 Live Evidence Completion Projection

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Project explicit live evidence task completions into task progress and timeline
read models without granting clients direct task mutation authority.

## Governing Refs

- `docs/roadmaps/g02/088-explicit-live-evidence-task-completion.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define completion-to-timeline projection records.
- [x] Rebuild completion progress from persisted completion records.
- [x] Expose read-only completion progress diagnostics.
- [x] Keep completion projection separate from SCM/share/change-request
      promotion.
- [x] Keep provider, callback, cancellation, resume, SCM, and raw material
      authority gated.

## Execution Plan

- [x] Completion timeline projection batch.
- [x] Completion progress projection batch.
- [x] Completion read-model diagnostics batch.
- [x] SCM/provider separation regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/409-live-evidence-completion-timeline-projection.md`
- `batch-cards/410-live-evidence-completion-progress-projection.md`
- `batch-cards/411-live-evidence-completion-read-model-diagnostics.md`
- `batch-cards/412-live-evidence-completion-scm-provider-separation.md`
- `batch-cards/413-live-evidence-completion-projection-closeout.md`

## Acceptance Criteria

- [x] Persisted explicit completions can produce deterministic timeline refs.
- [x] Progress projections rebuild from persisted completion records.
- [x] Read models expose completion without client mutation authority.
- [x] SCM/change-request/provider promotion remains separate.
- [x] The next lane is selected from evidence after validation.
