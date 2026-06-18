# 131 Codex Task Runtime Binding Contract

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../030-task-backed-agent-workflow-contract-reset.md`

## Purpose

Define how Codex runtime supervision binds to a task-backed work unit.

## Scope

- Name Codex-specific session/event refs.
- Map them to generic task work-unit refs.
- Preserve adapter capability differences.

## Acceptance Criteria

- Codex binding rules are explicit.
- Generic task workflow does not inherit Codex-only assumptions.
- Cancellation, wait, and recovery refs are named.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if Codex behavior would redefine generic harness contracts.
