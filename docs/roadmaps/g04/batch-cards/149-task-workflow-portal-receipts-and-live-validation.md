# 149 Task Workflow Portal Receipts And Live Validation

Status: completed
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

## Outcome

- Agent Chat now projects exactly `task_ledger` and `task_workflow`
- `task_workflow inspect` reports readiness and blockers for one task or Goal;
  `run` accepts only one exact task or one frozen Goal snapshot
- current-message excerpts, exact revisions, and stable idempotency keys create
  durable workflow mandates without treating selection or readiness as authority
- compact review-ready, blocked, stopped, and recovery receipts persist in chat
  history, refresh Tasks, and focus the correct Goal or task
- mandate, plan, work-item, and runtime-receipt detail stays behind the receipt
  disclosure
- authenticated natural-language Goal creation and two-task serial execution
  passed through the two portal tools
