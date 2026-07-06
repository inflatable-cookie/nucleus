# 018 Selected Task Work Loop Desktop Composition

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../004-selected-task-work-loop-composition.md`

## Purpose

Make the disposable desktop proof easier to follow for one selected task.

## Work

- [x] Compose selected project, selected task, workflow summary, and task
  drilldown into a clearer read-only path.
- [x] Keep the layout disposable and avoid final design claims.
- [x] Add guard tests for read-only behavior and no final-design language.
- [x] Avoid adding new task mutation controls.

## Acceptance Criteria

- [x] The selected-task context is visible without hunting across unrelated
  panels.
- [x] The proof remains a client of server state.
- [x] Svelte check and focused desktop tests pass.

## Result

`TaskWorkflowDrilldownProofPanel.svelte` now composes selected task identity,
project workflow context, task drilldown, guidance, evidence counts, and
missing-evidence areas into one disposable read-only proof path.

It consumes server-owned queries and does not add command controls, provider
execution, SCM mutation, or final UI design claims.
