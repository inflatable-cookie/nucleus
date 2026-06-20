# 087 Explicit Live Evidence Review Acceptance

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Accept review for live provider evidence only through an explicit operator
command, then keep task completion as a separate follow-up action.

## Governing Refs

- `docs/roadmaps/g02/086-durable-live-evidence-task-work-linkage.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define review acceptance admission over review-readiness records.
- [x] Persist review acceptance receipts without task completion.
- [x] Expose read-only diagnostics for accepted/rejected/needs-changes states.
- [x] Keep task completion explicit.
- [x] Keep callback, cancellation, resume, and SCM authority gated.

## Execution Plan

- [x] Review acceptance admission batch.
- [x] Review decision persistence batch.
- [x] Review diagnostics batch.
- [x] Task-completion separation regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/399-live-evidence-review-acceptance-admission.md`
- `batch-cards/400-live-evidence-review-decision-persistence.md`
- `batch-cards/401-live-evidence-review-diagnostics.md`
- `batch-cards/402-live-evidence-task-completion-separation.md`
- `batch-cards/403-live-evidence-review-acceptance-closeout.md`

## Acceptance Criteria

- [x] Review acceptance requires explicit operator command and readiness refs.
- [x] Accepted/rejected/needs-changes/abandoned decisions persist by reference.
- [x] Task completion remains separate from review acceptance.
- [x] Diagnostics expose review state without mutation authority.
- [x] Broad runtime authority remains gated.
