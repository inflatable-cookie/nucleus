# 259 Test Runtime Readiness Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Prove runtime readiness diagnostics are sanitized and client-safe.

## Scope

- Add server DTO tests.
- Add CLI or desktop helper tests.
- Assert no raw command output, credentials, or payload bytes appear.

## Out Of Scope

- Browser automation unless already practical.
- Remote host tests.

## Promotion Targets

- `crates/nucleus-server`
- `apps/nucleusd`
- `apps/desktop`

## Acceptance Criteria

- Tests fail if unsafe readiness data appears.
- Tests fail if clients depend on internal structs.

## Outcome

Added server DTO and desktop route tests that assert sanitized runtime
readiness responses exclude raw output, payload bytes, credentials, secrets,
and environment data.
