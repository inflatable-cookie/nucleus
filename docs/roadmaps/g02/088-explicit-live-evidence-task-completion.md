# 088 Explicit Live Evidence Task Completion

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Complete task work from live provider evidence only through a separate explicit
operator command after review acceptance has been persisted.

## Governing Refs

- `docs/roadmaps/g02/087-explicit-live-evidence-review-acceptance.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define task-completion admission over persisted accepted review decisions.
- [x] Persist task-completion decisions by reference.
- [x] Keep rejected, needs-changes, abandoned, duplicate, and blocked review
      decisions from closing task work.
- [x] Expose read-only completion diagnostics.
- [x] Keep provider writes, callback, cancellation, resume, SCM, and raw
      material authority gated.

## Execution Plan

- [x] Task-completion admission batch.
- [x] Task-completion persistence batch.
- [x] Completion diagnostics batch.
- [x] Non-acceptance and authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/404-live-evidence-task-completion-admission.md`
- `batch-cards/405-live-evidence-task-completion-persistence.md`
- `batch-cards/406-live-evidence-task-completion-diagnostics.md`
- `batch-cards/407-live-evidence-task-completion-authority-regressions.md`
- `batch-cards/408-live-evidence-task-completion-closeout.md`

## Acceptance Criteria

- [x] Only persisted accepted review decisions can admit task completion.
- [x] Task completion records retain refs, not raw provider material.
- [x] Completion remains explicit operator authority, not provider authority.
- [x] Diagnostics report completion state without mutation authority.
- [x] The next lane is selected from evidence after validation.
