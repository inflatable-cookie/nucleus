# 144 Task Ledger Goal Authoring

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../027-agent-chat-task-workflow-run.md`

## Purpose

Let Agent Chat inspect, create, refine, and populate Goals through the existing
`task_ledger` portal without adding a fifth tool.

## Work

- add typed goal DTOs and project-filtered goal inspection
- extend `task_ledger inspect`, `create`, and `update` with goal entities
- create tasks against an existing goal and update ordered membership through
  the goal revision boundary
- support creating a goal followed by its initial task runway in one provider
  turn
- retain conversation and provider-turn provenance
- add compact goal creation/update receipts and toolset migration

## Acceptance

- only `task_ledger` is exposed for goals and tasks
- natural goal-and-runway authoring succeeds without per-task confirmation
- goal membership changes are revision-safe and batch-validated
- task creation still grants no run authority
- authenticated create and refine smokes pass

## Evidence

- Goal create/update commands persist through the server-owned Planning domain
- `ControlGoalRecordDto` supports project-filtered ledger inspection
- `task_ledger` v4 is the only provider tool and supports task/goal entities
- task batches append to ordered Goal membership using an exact Goal revision
- Goal and task receipts retain conversation and provider-turn provenance
- authenticated create, runway population, inspect, and refine smoke passed
- 1,627 server tests, 31 planning/store tests, and desktop checks passed
