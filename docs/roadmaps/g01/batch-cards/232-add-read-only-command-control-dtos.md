# 232 Add Read-Only Command Control DTOs

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add DTOs for read-only command request and response payloads.

## Scope

- Add structured executable and argv fields.
- Add working directory, timeout, and output limit fields.
- Add sanitized evidence and rejection response fields.

## Out Of Scope

- Running commands.
- CLI input parsing.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- DTOs compile.
- Serialization tests cover accepted and rejected shapes.
- Raw output fields are absent.

## Closeout

Added `ControlCommandDto::ReadOnlyCommand` and
`ControlResponseBodyDto::ReadOnlyCommandResult`.

DTO tests prove the request round-trips and the result omits raw output fields.
