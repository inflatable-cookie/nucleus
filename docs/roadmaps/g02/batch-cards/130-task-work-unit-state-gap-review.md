# 130 Task Work Unit State Gap Review

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../030-task-backed-agent-workflow-contract-reset.md`

## Purpose

Compare existing task work-unit proof records to the required lifecycle.

## Scope

- Review current engine/server work-unit records.
- Identify missing source, projection, receipt, and review fields.
- Do not implement records in this card.

## Acceptance Criteria

- [x] Gaps are explicit and tied to follow-on cards.
- [x] Existing proof fields that can stay are named.
- [x] No runtime behavior changes.

## Result

The gap review is captured in
`docs/contracts/023-task-backed-agent-workflow-contract.md`. Existing
`EngineTaskWorkItemRecord` runtime/review separation can stay. Missing source
records, transition validation, provider binding refs, wait-state records,
recovery records, DTOs, timeline mapping, and idempotency rules move into
cards 134-138.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if missing state requires a larger contract rewrite.
