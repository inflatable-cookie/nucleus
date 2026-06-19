# 233 Harness Event Ingestion Runway

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../053-harness-runtime-rebaseline.md`

## Purpose

Prepare the next harness event-ingestion implementation runway.

## Scope

- Define event identity, receipt linkage, task-work linkage, and recovery
  expectations for the next provider lane.
- Prefer Codex as the first bridged runtime unless audit findings contradict
  that.
- Do not implement event ingestion in this card.

## Acceptance Criteria

- A next implementation card can be marked ready without fresh planning.
- Event ingestion is tied to runtime receipts and task work units.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if event identity or receipt linkage is still underspecified.
