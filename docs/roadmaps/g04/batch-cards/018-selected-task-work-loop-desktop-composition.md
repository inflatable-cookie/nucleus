# 018 Selected Task Work Loop Desktop Composition

Status: planned
Owner: Tom
Updated: 2026-07-06
Milestone: `../004-selected-task-work-loop-composition.md`

## Purpose

Make the disposable desktop proof easier to follow for one selected task.

## Work

- [ ] Compose selected project, selected task, workflow summary, and task
  drilldown into a clearer read-only path.
- [ ] Keep the layout disposable and avoid final design claims.
- [ ] Add guard tests for read-only behavior and no final-design language.
- [ ] Avoid adding new task mutation controls.

## Acceptance Criteria

- [ ] The selected-task context is visible without hunting across unrelated
  panels.
- [ ] The proof remains a client of server state.
- [ ] Svelte check and focused desktop tests pass.
