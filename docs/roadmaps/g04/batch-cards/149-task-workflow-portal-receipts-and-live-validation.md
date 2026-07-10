# 149 Task Workflow Portal Receipts And Live Validation

Status: planned
Owner: Codex
Updated: 2026-07-10
Milestone: `../027-agent-chat-task-workflow-run.md`

## Purpose

Expose the completed goal execution chain through one `task_workflow` portal
and compact chat/task presentation.

## Work

- register `task_workflow` with `inspect` and `run` actions
- accept one task or one goal mandate; reject arbitrary task arrays
- migrate existing provider threads through the toolset version
- add compact goal started, position, blocked, stopped, and recovery receipts
- refresh and focus the goal/task panel from receipts
- keep mandate, route, work-item, evidence, and recovery detail behind existing
  disclosures
- run natural-language goal creation, mandate, and serial execution smokes

## Acceptance

- the provider sees only `task_ledger` and `task_workflow` Nucleus tools
- one goal mandate runs its snapshot without per-task confirmation
- no atomic goal, lifecycle, delegation, scheduling, or dispatch tools appear
- receipts survive restart and open the correct goal/task context
- focused server, desktop, docs, and authenticated validation passes
