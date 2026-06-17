# 011 Task Timeline Query Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Expose the first read-only task timeline query through the server proof API.

## Scope

- Query type or helper for one task timeline.
- Server adapter from event store to timeline projection.
- DTO or record output sufficient for proof diagnostics.
- No write controls.

## Out Of Scope

- Desktop timeline panel.
- Provider transcript rendering.
- Live subscriptions.
- Cross-task timeline aggregation.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- [x] A task timeline can be queried after task command execution.
- [x] Query output includes source provenance and summary fields.
- [x] Existing task list/detail queries keep working.

## Stop Conditions

- Query design requires committing to final client protocol shape.

## Outcome

Added `TaskTimelineQuery`, `ServerQueryResult::TaskTimeline`, handler support,
and compact response DTOs.
