# 006 Task Command Admission And Mutation Tests

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add focused coverage for task command admission and mutation through the engine
service boundary.

## Scope

- Task create.
- Task update where current server behavior supports it.
- Task start/block/complete/archive transitions.
- Rejection cases for missing targets or stale records where represented.
- Event append before mutation.

## Out Of Scope

- Full task timeline projection.
- Agent assignment execution.
- Provider sessions.

## Promotion Targets

- `crates/nucleus-engine`
- `crates/nucleus-server`

## Acceptance Criteria

- [x] Focused tests prove engine task commands preserve existing mutation behavior.
- [x] Rejected/admitted command behavior remains explicit.
- [x] Event-store append still occurs before observable task mutation.

## Stop Conditions

- Tests require broad public API churn not covered by the engine boundary
  contract.

## Outcome

Added focused engine tests for create, update, transition, and invalid
agent-ready task rejection; preserved existing server task command tests.
