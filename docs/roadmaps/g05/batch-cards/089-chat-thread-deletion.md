# 089 Chat Thread Deletion

Status: completed
Owner: Tom
Created: 2026-08-07
Milestone: `../025-plan-decision-agent-chat.md`
Depends on: none
Auto-start next card: no

## Objective

Let the operator delete agent chat threads from the sidebar; the list grew
fast during plan-mode testing with no way to remove threads.

## Acceptance

- [x] one control command hard-deletes every record a conversation owns
  (session, metadata, actor selection, turns, messages, activities,
  questions, plan decisions, subagent directories)
- [x] deletion is project-scoped and rejects cross-project access; a second
  delete reports the thread as not found
- [x] the live provider session for the conversation is dropped
- [x] the sidebar offers a two-step delete per thread row; the open panel
  bound to a deleted thread resets to a fresh empty chat
- [x] a transient quick chat left threadless is removed through the project
  lifecycle (best effort; refusal leaves the empty chat row)
- [x] contract 019 states the Thread Deletion Rule

## Validation

- [x] persistence fixture covers full-record deletion, survivor isolation,
  repeat-delete rejection, cross-project rejection, and post-restart truth
- [x] focused server tests (71), desktop svelte-check and vitest pass

## Stop Conditions

- no tombstone or soft delete; the thread leaves storage entirely
- deleting a thread must not delete non-transient projects
- do not cancel or interrupt an in-flight turn implicitly; the chat mutex
  keeps delete serialized behind sends

## Evidence

- `persistence::delete_thread` (`local_codex_chat/persistence.rs`) collects
  records by prefix and payload conversation id and deletes through the
  server-owned state accessor; `LocalCodexChatService::delete_thread` drops
  the live session first.
- Tauri `delete_agent_chat_thread`; desktop `deleteAgentChatThread`;
  `ThreadsSidebarView` two-step delete; `ProjectWorkspaceStage` rebinds
  affected panels to a fresh conversation on `nucleus:agent-chat-thread-deleted`.
