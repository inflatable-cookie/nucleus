# 123 Local Agent Chat Vertical Slice

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../025-initial-agent-chat-vertical-slice.md`

## Purpose

Connect the existing Agent Chat panel to one real local Codex conversation.

## Scope

- add a server-owned local Codex chat service
- resolve the selected project repository from server state
- retain one provider process and thread per chat panel
- send follow-up turns through the same thread
- render user and assistant messages in the existing panel
- keep the first runtime read-only and reject unsupported provider callbacks
- leave tasks and workspace shell behavior unchanged

## Acceptance

- Rust and Svelte checks pass
- a live two-turn Codex smoke keeps both turns on one thread
- the Agent Chat panel handles empty, pending, message, and error states
- no task mutation or workspace layout change is introduced
