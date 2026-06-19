# 230 Harness Runtime Contract Gap Review

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../053-harness-runtime-rebaseline.md`

## Purpose

Review harness runtime contracts before the next provider implementation lane.

## Scope

- Compare adapter, session, timeline, receipt, native runtime, and task-backed
  workflow contracts.
- Update gap indexes where the contracts are stale.
- Do not implement provider behavior.

## Acceptance Criteria

- Harness runtime contract gaps are explicit.
- Any blocker is visible before code work starts.

## Result

Contracts now state that the current Codex adapter surface is metadata,
fixture, and compile-only proof work. Live session binding, transport
ingestion, event-store append, receipt linkage, and recovery records remain
the next gate.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if a missing contract would make implementation speculative.
