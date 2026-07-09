# 077 Selected Task Rework Control Surfaces

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../016-selected-task-rework-from-review-outcome.md`

## Purpose

Expose selected-task rework preparation through the existing server control
surfaces.

## Work

- [x] Add read-only server query/control DTOs.
- [x] Add `nucleusd query` rendering for the rework preparation preview.
- [x] Add an Effigy selector for the same query.
- [x] Add request/response DTO and CLI rendering tests.

## Acceptance Criteria

- [x] CLI and Effigy output show status, refusal, route refs, decision refs,
  work-item refs, evidence refs, and no-effect flags.
- [x] Serialized control envelopes do not expose raw provider payloads.
- [x] The query cannot schedule work or mutate tasks.

## Result

Selected-task rework preparation now has a read-only server query, control
request/response DTOs, `nucleusd` rendering, and an Effigy smoke selector.

The surface reports route/refusal state, reviewed work and evidence refs,
operator and revision guards, no-effect flags, and explicit read-only
availability flags. It does not expose raw provider payloads, schedule agents,
create work items, mutate tasks, run providers, or touch SCM/forge state.

## Validation

- `cargo test -p nucleus-server selected_task_rework -- --nocapture`
- `cargo test -p nucleusd selected_task_rework -- --nocapture`
- `effigy server:query:selected-task-rework-preparation`
