# 134 Active Task Conversation Context

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../026-agent-chat-task-context.md`

## Purpose

Let the operator focus a task in the Tasks panel and discuss it in Agent Chat
without copying task details into the message or expanding the main UI.

## Scope

- bind the current Tasks-panel selection into the Agent Chat panel
- show one compact removable context label near the composer
- send only the selected task id across the client boundary
- resolve the current project-owned task record on the server for every turn
- give the provider bounded current task context while persisting the original
  user message unchanged

## Excludes

- durable conversation-to-task binding
- implicit task mutation
- lifecycle transitions, assignment, or dispatch
- selected-task workflow aggregates or proof diagnostics in chat

## Acceptance

- no selected task preserves the existing chat request and presentation
- a selected task is visible and removable in the composer
- a selected task from another project or a missing task fails closed
- provider context uses current server state, not client-supplied task fields
- stored conversation history contains the operator's original message only
- focused server tests and desktop checks pass

## Evidence

- `crates/nucleus-server/src/local_codex_chat.rs`
- `crates/nucleus-server/src/local_codex_chat/task_inspection.rs`
- `apps/desktop/src/lib/ProjectWorkspaceStage.svelte`
- `apps/desktop/src/lib/AgentChatPanel.svelte`
- `cargo test -p nucleus-server local_codex_chat --no-fail-fast`
- `effigy desktop:check`
