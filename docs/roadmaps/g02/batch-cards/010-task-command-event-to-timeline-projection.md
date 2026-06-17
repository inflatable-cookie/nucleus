# 010 Task Command Event To Timeline Projection

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Project current task command-admitted events into a deterministic task
timeline read model.

## Scope

- Read orchestration command-admitted events.
- Select task-family events.
- Produce task timeline entries with command/event provenance.
- Preserve deterministic rebuild behavior.

## Out Of Scope

- Full task state diffing.
- Runtime receipts.
- Provider event ingestion.
- Background live projector.

## Promotion Targets

- `crates/nucleus-orchestration`
- `crates/nucleus-engine`
- `crates/nucleus-server`

## Acceptance Criteria

- [x] Rebuilding from the same event set produces the same timeline projection.
- [x] Non-task events are ignored or classified explicitly.
- [x] Malformed event records fail closed through the existing event-store boundary.

## Stop Conditions

- Projection requires re-running task commands or other side effects.

## Outcome

Added deterministic task timeline rebuild from task-targeted command-admitted
events.
