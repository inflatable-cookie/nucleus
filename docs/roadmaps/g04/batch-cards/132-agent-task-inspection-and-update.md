# 132 Agent Task Inspection And Update

Status: completed
Owner: Tom
Updated: 2026-07-10
Milestone: `../026-agent-chat-task-context.md`

## Purpose

Let the chat agent inspect and refine the task ledger after autonomous creation
without giving it dispatch authority.

## Work

- expose a compact server-owned task-list/read tool to Agent Chat
- expose revision-safe task updates through the existing task command boundary
- support single and batch refinement without chat-card spam
- refresh and focus affected task records in the proper Tasks panel
- retain conversation and provider-turn provenance for agent updates

## Acceptance

- the agent can read current task fields without SQLite or raw storage access
- updates require current task revisions and fail clearly on conflict
- updates cannot delegate, start, complete, archive, or dispatch tasks
- affected records refresh in the Tasks panel

## Evidence

- project-scoped inspection returns typed task fields and current revisions
- stale updates fail before any command executes
- update commands preserve lifecycle state and append conversation/turn refs
- authenticated Codex smoke naturally listed and updated an existing task
- a create-only conversation migrated once to the expanded task toolset
