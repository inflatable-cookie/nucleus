# 002 Event Store Repository Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Introduce a storage-agnostic repository boundary for orchestration event
append and read operations.

## Scope

- Event append trait.
- Event list/read trait.
- Server-state adapter for the current local store.
- Error mapping that distinguishes malformed records, storage failure, and
  unsupported projection data.
- Tests through in-memory/local fixtures.

## Out Of Scope

- PostgreSQL adapter.
- SQLite schema redesign.
- Cross-host replication.
- Projection export to SCM management files.

## Promotion Targets

- `docs/contracts/022-engine-orchestration-boundary-contract.md`
- `crates/nucleus-orchestration`
- `crates/nucleus-server`

## Acceptance Criteria

- [x] Command admission no longer appends orchestration events by hand-crafting
  request-handler persistence records.
- [x] Projection rebuild reads events through the repository boundary.
- [x] The repository boundary does not assume a concrete database backend.

## Stop Conditions

- Repository traits expose SQLite-specific concepts as the generic contract.

## Outcome

- Added `OrchestrationEventStoreRepository` in `nucleus-orchestration`.
- Added `ServerOrchestrationEventStore` as the current local-store adapter.
- Rewired command-admitted event append and projection rebuild through the
  repository boundary.
