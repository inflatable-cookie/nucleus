# 131 Proper Task Panel Foundation

Status: completed
Owner: Tom
Updated: 2026-07-10
Milestone: `../026-agent-chat-task-context.md`

## Purpose

Make agent-authored tasks visible and navigable in the approved workspace
panel set.

## Scope

- mount the existing server-backed task query in the system Tasks tab
- expose authored acceptance, readiness, context, stop, and validation fields
  through the typed task DTO
- show a quiet task list and one selected-task detail
- keep dense fields under one Advanced disclosure
- let chat task receipts focus the Tasks tab and select a single created task
- preserve the disposable proof harness without copying its UI shape

## Acceptance

- the Tasks tab no longer renders a placeholder
- task creation is visible without opening the proof harness
- selection shows the fields the agent authored
- receipt navigation works for single and batch creation
- no task dispatch or proof diagnostics enter the product panel
