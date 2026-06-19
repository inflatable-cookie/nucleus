# 238 Codex Task Runtime Observation Links

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../054-codex-live-event-acceptance.md`

## Purpose

Link accepted Codex observations to task work items without direct task
mutation.

## Scope

- Add reference-only task-work observation link records.
- Expose work-item evidence refs for accepted events, unsupported observations,
  wait states, and receipts.
- Keep runtime completion separate from review acceptance and task completion.
- Do not implement automatic task state transitions.

## Acceptance Criteria

- Task work items can query relevant accepted observation refs.
- Provider completion cannot complete a task.
- Wait and recovery states stay visible.

## Validation

- targeted engine/server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if linkage would copy raw provider streams into task records.
