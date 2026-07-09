# 073 Selected Task Completion Route Desktop Proof

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../015-selected-task-completion-from-route-admission.md`

## Purpose

Add a disposable desktop proof for completion-from-route readiness.

## Work

- [x] Render route-backed completion readiness beside route admission.
- [x] Keep explicit operator and expected revision visible before any later
  apply command exists.
- [x] Keep task completion apply disabled because no explicit mutation command
  is in scope.
- [x] Add guard checks that prevent provider, SCM, planning, memory, and final UI
  effects.

## Acceptance Criteria

- [x] The proof cannot complete from route status alone.
- [x] The proof cannot complete from route admission alone.
- [x] Stale-client protection remains visible.
- [x] No rework, delegation, SCM, provider, planning, or memory controls are
  added.

## Result

Added a desktop control query and disposable proof panel rendering for
`selected_task_completion_route_apply`.

The proof now loads the same server-owned read-only preview exposed by
`nucleusd` and Effigy. It shows route admission id, review decision ref,
command candidate, expected revision, evidence count, refusal status, operator
ref, and no-effect flags beside route admission.

The proof surface now opens from a top-level desktop-shell modal launcher rather
than living in the main panel grid. This keeps it available for inspection while
making it easy to replace the real UI later without deleting the proof.

The visible apply control is disabled. This batch does not add a task mutation
command, receipt, or timeline refresh path because the server lane currently
exposes only a preview query. Actual route-backed task completion remains behind
a future explicit command boundary.

## Validation

- `effigy desktop:check`
