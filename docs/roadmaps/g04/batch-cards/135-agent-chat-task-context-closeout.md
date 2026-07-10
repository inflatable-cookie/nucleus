# 135 Agent Chat Task Context Closeout

Status: completed
Owner: Tom
Updated: 2026-07-10
Milestone: `../026-agent-chat-task-context.md`

## Purpose

Validate the operator interaction and choose the next workflow lane now that
chat can create, inspect, refine, and focus tasks.

## Operator Check

- select a task in the Tasks panel
- return to Agent Chat and confirm the compact context label is present
- ask a question that refers to "this task" without naming it
- clear the context label and confirm normal project chat remains unchanged

## Next-Lane Candidates

- proposal cards only for materially ambiguous task intent
- explicit task dispatch with one primary action
- minimal task lifecycle controls

## Acceptance

- active-task context works in the running desktop
- the operator selects the next workflow lane
- the chosen lane keeps authoring, lifecycle, and dispatch authority distinct

## Decision

Before adding another workflow capability, consolidate the three atomic task
tools behind one `task_ledger` portal. Adopt four long-term agent-facing portal
domains: task ledger, task workflow, project context, and work evidence.

## Evidence

- operator correction on 2026-07-10
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
