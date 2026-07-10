# 142 Task Workflow Portal Receipts And Live Validation

Status: superseded
Owner: Codex
Updated: 2026-07-10
Milestone: `../027-agent-chat-task-workflow-run.md`

## Purpose

Expose the complete workflow chain through one portal and the existing simple
chat/task UI.

## Work

- register one `task_workflow` tool with `inspect` and `run` actions
- migrate existing provider threads through the durable toolset version
- require the current conversation mandate fields for `run`
- add compact started, runway-position, blocked, stopped, and recovery receipts
- refresh and focus Tasks from receipts without adding a workflow control stack
- place detailed mandate, route, work-item, and recovery data behind existing
  task detail disclosures
- run natural-language single-task and runway live smokes

## Acceptance

- the provider sees only `task_ledger` and `task_workflow` Nucleus tools
- one explicit conversation instruction can run its admitted scope without
  per-task confirmations
- no atomic lifecycle, delegation, scheduling, or dispatch tools are exposed
- receipts survive restart and open the correct task context
- focused server, desktop, docs, and authenticated live validation passes

## Superseded By

`149-task-workflow-portal-receipts-and-live-validation.md`.
