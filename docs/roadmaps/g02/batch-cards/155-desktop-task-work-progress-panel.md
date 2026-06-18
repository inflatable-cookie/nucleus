# 155 Desktop Task Work Progress Panel

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../035-desktop-task-agent-progress-proof.md`

## Purpose

Render task work-unit progress in the disposable desktop proof shell.

## Scope

- Add a compact Svelte/Poodle panel.
- Reuse control helpers.
- Show records, empty state, unsupported state, and errors.

## Acceptance Criteria

- Desktop can inspect work-unit progress.
- Panel is read-only.
- Empty and error states are distinct.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if panel work becomes final UI design.

## Result

- Added `TaskWorkProgressPanel.svelte` to the disposable desktop proof shell.
- Reused the control envelope helpers and response mappers.
- Rendered loading, empty, unsupported, error, list, and detail states.
