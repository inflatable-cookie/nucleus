# 258 Add Runtime Readiness Query DTO

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add a typed query response DTO for runtime readiness diagnostics if the current
control surface is too generic.

## Scope

- Reuse existing query vocabulary where possible.
- Add typed response records.
- Keep response sanitized.

## Out Of Scope

- Remote transport.
- Live subscriptions.
- Command execution.

## Promotion Targets

- `crates/nucleus-server`
- `apps/nucleusd`
- `apps/desktop`

## Acceptance Criteria

- Clients can render readiness without internal storage or runtime structs.
- Unsupported readiness remains explicit.

## Outcome

Added `get_local_runtime_readiness` control query support and typed response
DTOs for server and desktop clients.
