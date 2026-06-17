# 009 Task Timeline Record Shape

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the first task timeline record and projection shape.

## Scope

- Timeline entry id.
- Task id.
- Source command id.
- Source event id or event cursor.
- Entry kind for task command activity.
- Human-readable summary.
- Projection provenance.

## Out Of Scope

- Provider messages.
- Tool calls.
- Runtime receipt projection.
- UI timeline panels.
- SCM checkpoint links.

## Promotion Targets

- `crates/nucleus-engine`
- `crates/nucleus-tasks`
- `docs/contracts/019-conversation-timeline-contract.md`

## Acceptance Criteria

- [x] Task timeline records have stable ids and source provenance.
- [x] Timeline projection shape does not copy raw provider/runtime payloads.
- [x] Record vocabulary can represent current task command events.

## Stop Conditions

- The record shape requires provider runtime identity before provider runtime
  selection is complete.

## Outcome

Added engine-owned task timeline entry, summary, provenance, and projection
types.
