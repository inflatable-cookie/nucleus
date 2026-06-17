# 233 Route Read-Only Command Requests To Spawn Helper

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Route accepted read-only command control requests to the server spawn helper.

## Scope

- Convert DTO input to command request and invocation values.
- Build or require host readiness for local execution.
- Persist sanitized evidence.

## Out Of Scope

- Arbitrary shell strings.
- PTY and streaming.
- Write-enabled commands.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Accepted request can finish through the spawn helper.
- Rejected request does not spawn.
- Evidence is persisted once.

## Closeout

Added `run_read_only_command_control` and routed
`ServerCommandKind::ReadOnlyCommand` through the local request handler.

Accepted requests run through the existing server read-only spawn helper and
persist sanitized command evidence.
