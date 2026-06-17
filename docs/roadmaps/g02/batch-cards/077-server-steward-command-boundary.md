# 077 Server Steward Command Boundary

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../019-native-steward-command-boundary.md`

## Purpose

Prepare server request-handler boundaries for steward commands.

## Scope

- Add server-facing command admission DTOs where needed.
- Route steward command requests through engine/native records.
- Return explicit rejected, blocked, and unsupported states.
- Do not execute live steward tools.

## Acceptance Criteria

- [x] Server boundary can accept a steward command request shape.
- [x] Server boundary can reject unsupported command classes.
- [x] No command handler mutates project, SCM, or forge state.

## Outcome

- Added `ServerCommandKind::Steward` for native steward command requests.
- Added request-handler admission for steward commands.
- Added receipt statuses for accepted native steward commands and
  waiting-for-approval.
- Kept live steward execution, project mutation, SCM mutation, and forge calls
  out of scope.

## Validation

- [x] `cargo test -p nucleus-server steward`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if this needs a live native runtime loop.
