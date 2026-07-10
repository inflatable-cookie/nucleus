# 139 Task Workflow Inspection And Run Readiness

Status: superseded
Owner: Codex
Updated: 2026-07-10
Milestone: `../027-agent-chat-task-workflow-run.md`

## Purpose

Compose the product-shaped workflow state needed by `task_workflow inspect` and
run admission without exposing the portal yet.

## Work

- compose task identity, current revision, readiness, dependencies, stop
  conditions, validation policy, active work, and blockers
- close dependency/readiness fields missing from the current task DTO where
  needed
- resolve explicit task scope and snapshot a current ready runway of at most 50
  tasks in deterministic dependency order
- refuse cycles, missing dependencies, stale revisions, conflicting work, and
  unsupported task state
- return compact workflow summaries rather than proof-query internals

## Acceptance

- inspect and runway resolution are read-only and deterministic
- each scoped task retains its own revision and blockers
- detailed evidence payloads remain outside this view
- focused server and DTO tests pass

## Superseded By

`147-goal-run-inspection-and-admission.md`.
