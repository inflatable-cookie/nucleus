# 234 Add Read-Only Command Rejection And Persistence Tests

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Cover the read-only command control path with focused acceptance tests.

## Scope

- Accepted command path.
- Shell passthrough rejection.
- Invalid working directory rejection.
- Missing timeout or unbounded output rejection.
- Sanitized persistence assertion.

## Out Of Scope

- Platform matrix.
- Long-running process supervision.
- Desktop UI tests.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Tests prove blocked requests do not spawn.
- Tests prove accepted requests persist sanitized evidence.
- Tests prove raw output is absent.

## Closeout

Added focused tests for accepted execution, shell passthrough rejection,
invalid working directory rejection, missing timeout/unbounded output rejection,
handler routing, and sanitized evidence persistence.
