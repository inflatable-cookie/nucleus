# 094 Steward Diagnostics Read Model

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../023-client-read-model-and-diagnostics-runway.md`

## Purpose

Expose steward proposal, command, approval, and receipt state to clients.

## Scope

- Add read-model records or DTOs for steward diagnostics.
- Keep clients read-only.
- Preserve server authority over command and proposal state.

## Acceptance Criteria

- Clients can inspect steward proposal and command state.
- Approval state is visible.
- DTOs do not allow client-owned mutation.

## Validation

- `cargo test -p nucleus-server steward`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if client DTOs become authority records.
