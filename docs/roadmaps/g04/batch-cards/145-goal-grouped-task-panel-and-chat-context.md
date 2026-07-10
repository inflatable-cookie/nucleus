# 145 Goal Grouped Task Panel And Chat Context

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../027-agent-chat-task-workflow-run.md`

## Purpose

Replace the flat Tasks-panel list with simple goal grouping and make one
selected Goal available as removable chat context.

## Work

- query project goals beside tasks
- render goal groups with title, status, progress summary, and ordered task rows
- keep ungrouped tasks in one final compact section
- place goal outcome, scope, stop conditions, refs, and identifiers behind
  detail or disclosures
- focus a created/updated goal from chat receipts
- attach selected-goal id to Agent Chat and resolve current server context per
  turn
- preserve all existing panel placement and shell behavior

## Acceptance

- the normal Tasks panel is no longer one unlimited flat list
- selecting a goal or contained task is clear without adding a dashboard
- active-goal context is compact and removable
- selection does not grant run authority
- `effigy desktop:check` and panel guard tests pass

## Evidence

- typed Goal state queries route through the server, DTO, Tauri, and desktop client boundaries
- the proper Tasks panel renders canonical Goal groups, ordered task rows, progress, and a final Ungrouped section
- Goal and task selection share the existing detail pane; advanced Goal fields remain behind disclosure
- Goal receipts focus the Tasks panel and selected Goal/Task context is removable in Agent Chat
- current Goal and Task records are resolved server-side for every provider turn
- selection is explicitly described as focus only and creates no mandate or runtime effect
- server, desktop, Svelte, and panel guard tests pass
