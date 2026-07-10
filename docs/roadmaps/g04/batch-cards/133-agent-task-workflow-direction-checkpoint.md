# 133 Agent Task Workflow Direction Checkpoint

Status: completed
Owner: Tom
Updated: 2026-07-10
Milestone: `../026-agent-chat-task-context.md`

## Purpose

Choose the next operator-visible task interaction now that chat can create,
inspect, and refine the task ledger.

## Candidates

- proposal cards for materially ambiguous task intent
- explicit task dispatch from chat or the Tasks panel
- minimal lifecycle controls for ready, active, blocked, and done states
- active-task context attached to an ongoing conversation

## Acceptance

- the operator selects active-task conversation context as the next interaction
- its normal path stays visually simple
- advanced controls remain behind menus or disclosures
- task authoring, lifecycle mutation, and dispatch authorities stay distinct

## Decision

The selected task may be attached to Agent Chat as bounded context for each
turn. Selection does not mutate, dispatch, or change the task lifecycle.

## Evidence

- operator continued after the active-task context recommendation
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/architecture/product-workflow-ui-architecture.md`
