# 130 Task Work Unit State Gap Review

Status: planned
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

- Gaps are explicit and tied to follow-on cards.
- Existing proof fields that can stay are named.
- No runtime behavior changes.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if missing state requires a larger contract rewrite.
