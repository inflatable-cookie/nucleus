# 096 Live Evidence Task State History Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Persist explicit live-evidence task-state history/control records so completion
SCM readiness can read real source state instead of reporting missing history.

## Governing Refs

- `docs/roadmaps/g02/092-live-evidence-completion-task-state-transition.md`
- `docs/roadmaps/g02/093-live-evidence-task-state-control-integration.md`
- `docs/roadmaps/g02/095-completion-scm-readiness-control-integration.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Persist sanitized task-state control records.
- [x] Read persisted task-state history records from state.
- [x] Keep duplicate persistence deterministic.
- [x] Feed persisted history into completion SCM readiness diagnostics.
- [x] Keep task mutation, SCM, forge, provider, callback, and recovery effects gated.

## Execution Plan

- [x] Persistence record batch.
- [x] Persistence/read API batch.
- [x] Duplicate and repair-state batch.
- [x] Completion SCM source integration batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/444-live-evidence-task-state-control-persistence-records.md`
- `batch-cards/445-live-evidence-task-state-control-state-api.md`
- `batch-cards/446-live-evidence-task-state-duplicate-repair-regressions.md`
- `batch-cards/447-completion-scm-persisted-history-source.md`
- `batch-cards/448-task-state-history-persistence-closeout.md`

## Acceptance Criteria

- [x] Task-state control records persist sanitized refs and history entries.
- [x] Duplicate task-state persistence is deterministic.
- [x] Completion SCM diagnostics can read persisted task-state history.
- [x] Missing/repair states remain visible.
- [x] No external effects execute.

## Closeout

Live-evidence task-state control records now persist sanitized task/work,
completion, admission, history, operator, and evidence refs. Persisted records
rebuild task-state history for completion SCM readiness diagnostics, while
blocked task-state controls remain repair evidence and do not create SCM
candidates.

Next lane: admit completion SCM capture requests from persisted readiness
without executing capture, publish, review-request, merge, or forge effects.
