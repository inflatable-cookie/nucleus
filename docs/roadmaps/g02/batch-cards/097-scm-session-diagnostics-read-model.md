# 097 SCM Session Diagnostics Read Model

Status: planned
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

- Clients can inspect session mode, testability, and cleanup policy.
- Task linkage and repair states are visible.
- DTOs do not assume Git-only terms.

## Validation

- `cargo test -p nucleus-server scm`
- `cargo test -p nucleus-scm-forge`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics require working-copy mutation.
