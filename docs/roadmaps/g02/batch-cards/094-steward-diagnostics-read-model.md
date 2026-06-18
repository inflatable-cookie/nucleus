# 094 Steward Diagnostics Read Model

Status: completed
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

- [x] Clients can inspect steward proposal and command state.
- [x] Approval state is visible.
- [x] DTOs do not allow client-owned mutation.

## Outcome

- Added steward diagnostics DTOs for proposals, command admission, command
  outcomes, approval state, refs, and summaries.
- Kept diagnostics read-only.

## Validation

- [x] `cargo test -p nucleus-server steward`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if client DTOs become authority records.
