# 077 Server Steward Command Boundary

Status: planned
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

- Server boundary can accept a steward command request shape.
- Server boundary can reject unsupported command classes.
- No command handler mutates project, SCM, or forge state.

## Validation

- `cargo test -p nucleus-server steward`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if this needs a live native runtime loop.
