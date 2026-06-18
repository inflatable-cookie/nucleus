# 131 Codex Task Runtime Binding Contract

Status: completed
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

- [x] Codex binding rules are explicit.
- [x] Generic task workflow does not inherit Codex-only assumptions.
- [x] Cancellation, wait, and recovery refs are named.

## Result

`023-task-backed-agent-workflow-contract.md` defines Codex as one runtime
binding. Codex session, thread, turn, item, approval, input, transport, and
unsupported-observation refs are external refs under Nucleus-owned task,
work-item, timeline, receipt, checkpoint, and review ids.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if Codex behavior would redefine generic harness contracts.
