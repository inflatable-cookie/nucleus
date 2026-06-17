# 157 Promote Structured Command Invocation Records

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Promote structured command invocation records into command-policy/server Rust
types.

## Scope

- Represent executable and argv separately.
- Represent working directory, timeout, and output bound.
- Keep shell strings out of the invocation record.

## Out Of Scope

- Process spawning.
- Shell parsing.
- Raw output retention.

## Promotion Targets

- `crates/nucleus-command-policy`
- `crates/nucleus-server`

## Acceptance Criteria

- Invocation records compile and round-trip through tests.
- Shell passthrough remains rejected.
- Existing runner skeleton uses the promoted record shape.

## Closeout

- Added `CommandInvocation` and `CommandEnvironmentPolicy` to
  `nucleus-command-policy`.
- Updated the local read-only runner skeleton and `nucleusd` smoke path to use
  the promoted invocation record.
- No process spawning was introduced.
