# 108 Selected Task Aggregate Workspace Panel

Status: superseded
Owner: Tom
Updated: 2026-07-09
Milestone: `../022-selected-task-aggregate-product-shell-placement.md`

## Purpose

Render a read-only selected-task aggregate summary inside the normal workspace
stage.

## Work

- [x] Load the aggregate when the active project and selected task are known.
- [x] Show task identity, primary next action, readiness, command preview,
  work evidence, review, rework, completion, SCM handoff, and source health at
  summary level.
- [x] Keep the panel visually conservative and consistent with the current dark
  shell.
- [x] Avoid final workflow controls.

## Acceptance Criteria

- [x] The normal shell shows useful selected-task workflow state.
- [x] The proof harness remains optional and separate.
- [x] The panel is read-only.

## Result

Added `SelectedTaskAggregatePanel.svelte` and wired it into the normal product
workspace stage as a read-only workflow summary.

Superseded after operator correction. The component was removed from the normal
workspace.
