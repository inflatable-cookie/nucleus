# 097 SCM Session Diagnostics Read Model

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../023-client-read-model-and-diagnostics-runway.md`

## Purpose

Expose SCM working-session plans, constraints, and task linkage to clients.

## Scope

- Add read-model records or DTOs for SCM session diagnostics.
- Show primary-tree versus isolated-location tradeoffs.
- Preserve provider-neutral vocabulary.

## Acceptance Criteria

- [x] Clients can inspect session mode, testability, and cleanup policy.
- [x] Task linkage and repair states are visible.
- [x] DTOs do not assume Git-only terms.

## Outcome

- Added SCM session diagnostics DTOs for session plans, command admissions, and
  work-item linkage.
- Preserved provider-neutral session mode and repair visibility.

## Validation

- [x] `cargo test -p nucleus-server scm`
- [x] `cargo test -p nucleus-scm-forge`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if diagnostics require working-copy mutation.
