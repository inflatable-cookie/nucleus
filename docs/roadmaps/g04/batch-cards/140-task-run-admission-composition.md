# 140 Task Run Admission Composition

Status: superseded
Owner: Codex
Updated: 2026-07-10
Milestone: `../027-agent-chat-task-workflow-run.md`

## Purpose

Compose one conversation mandate into an admitted serial run plan without
pretending admission is provider execution.

## Work

- bind validated mandate scope to current workflow inspection records
- resolve the configured adapter, provider instance, and model route through
  server-owned registries
- compose revision, dependency, readiness, stop-condition, idempotency, and
  conflicting-work admission
- reuse the existing task delegation and work-item boundaries internally
- persist one ordered run plan and first admitted work item
- keep provider invocation and task lifecycle effects disabled

## Acceptance

- an admitted plan contains everything required for provider handoff
- blocked plans return one primary reason plus complete structured blockers
- repeated idempotency keys do not create duplicate work items
- no portal or provider effect is exposed yet
- focused admission tests pass

## Superseded By

`147-goal-run-inspection-and-admission.md`.
