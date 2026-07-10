# 147 Goal Run Inspection And Admission

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../027-agent-chat-task-workflow-run.md`

## Purpose

Compose goal workflow inspection and an admitted serial run plan without
exposing partial provider behavior.

## Work

- inspect goal status, revision, ordered tasks, progress, blockers, stop
  conditions, dependencies, active work, and available outcomes
- resolve current task revisions and deterministic dependency-compatible order
- bind the validated mandate snapshot
- resolve configured adapter, provider instance, and model route
- compose readiness, idempotency, conflicting-work, work-item, and dispatch
  admission records
- persist an ordered run plan and first admitted work item
- keep provider invocation disabled until the next card

## Acceptance

- arbitrary task arrays and project-ready sweeps are rejected
- every plan is traceable to one goal mandate
- blockers identify goal-level and task-level causes
- idempotent repeats create no duplicate work
- no portal or provider effect is exposed yet
