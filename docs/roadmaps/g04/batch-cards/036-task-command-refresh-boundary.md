# 036 Task Command Refresh Boundary

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../008-task-command-outcome-coherence.md`

## Purpose

Define the desktop shell refresh boundary after a selected-task command receipt.

## Work

- [x] Add an explicit task-command success callback from the workflow proof
  panel to the shell.
- [x] Reuse the existing task-list refresh token instead of creating a second
  client state authority.
- [x] Keep command receipt parsing inside the server response boundary.
- [x] Add a guard that the workflow panel does not refresh from local mutation
  assumptions.

## Acceptance Criteria

- [x] Task command success can trigger task-list refresh from `App.svelte`.
- [x] The selected task remains sourced from server task records.
- [x] No provider, SCM/forge, delegation, review, memory, or planning apply
  controls are introduced.

## Result

- Added `onTaskCommandChanged` from the workflow proof panel to the shell.
- Routed successful task command receipts to the existing `taskRefreshToken`.
- Added guards that the workflow panel emits a refresh signal and does not
  mutate selected-task fields locally.
