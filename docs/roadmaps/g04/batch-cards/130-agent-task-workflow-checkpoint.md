# 130 Agent Task Workflow Checkpoint

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../026-agent-chat-task-context.md`

## Purpose

Choose the next task interaction after autonomous creation is proven, without
letting the task UI become the primary workflow.

## Candidates

- open or focus a created task from its compact chat receipt
- let the agent inspect and update existing tasks through tools
- attach one active task as conversation context
- add proposal cards for materially ambiguous task intent
- prepare explicit task dispatch as a separate authority step

## Acceptance

- one next interaction is selected by the operator
- its minimal visible UI is described before implementation
- advanced task detail remains in the task panel or a popover
- task authoring and task dispatch remain separate authorities

## Decision

Connect the proper Tasks panel before adding more task tools. Use a simple
list, selected-task detail, and receipt-to-task focus. Keep proof workflow
diagnostics out of the product panel.
