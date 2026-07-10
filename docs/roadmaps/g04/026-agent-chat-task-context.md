# 026 Agent Chat Task Context

Status: completed
Owner: Tom
Updated: 2026-07-09

## Purpose

Connect the durable Agent Chat conversation to Nucleus task context without
turning the task panel into the primary workflow.

## Boundary

This lane may:

- expose selected-task context to an Agent Chat conversation
- let the agent create one task or a task runway through a server-authorized
  tool boundary
- let the agent fill all task fields supported by conversation context
- show compact durable creation receipts inside chat
- reserve proposal cards for materially ambiguous work

This lane must not:

- let the client or provider mutate tasks directly
- expose the full selected-task proof aggregate inside chat
- add automatic dispatch, provider write, or SCM behavior
- change workspace surface or panel placement behavior

## Batch Cards

Ready cards:

- None.

Completed cards:

- `batch-cards/137-task-workflow-portal-design-review.md`
- `batch-cards/136-task-ledger-portal-consolidation.md`
- `batch-cards/135-agent-chat-task-context-closeout.md`
- `batch-cards/134-active-task-conversation-context.md`
- `batch-cards/133-agent-task-workflow-direction-checkpoint.md`
- `batch-cards/126-chat-task-context-design-review.md`
- `batch-cards/127-agent-task-authoring-tool.md`
- `batch-cards/128-agent-task-creation-receipts.md`
- `batch-cards/129-live-agent-task-authoring-validation.md`
- `batch-cards/130-agent-task-workflow-checkpoint.md`
- `batch-cards/131-proper-task-panel-foundation.md`
- `batch-cards/132-agent-task-inspection-and-update.md`
