# 090 Resource-Free Chat Sentinel Resolution

Status: completed
Owner: Tom
Created: 2026-08-07
Milestone: `../025-plan-decision-agent-chat.md`
Depends on: card 088
Auto-start next card: no

## Objective

Fix plan acceptance on resource-free chats: the follow-up turn failed with
"project resource target not found: resource:none".

## Root Cause

Resource-free chats persist the `resource:none` sentinel as the stored
session's resource id. The accept path rebuilds a send request from the
stored session, so the sentinel was resolved as a literal project resource
and rejected.

## Acceptance

- [x] the `resource:none` sentinel resolves as resource-free wherever a chat
  working context is resolved, including from a stored session
- [x] ordinary sends and plan-accept follow-ups on resource-free chats work

## Validation

- [x] the resource-free context test now also resolves the sentinel form
  (`cargo test -p nucleus-server local_codex_chat`: 71 passed)

## Stop Conditions

- do not invent a real resource for resource-free chats
- do not change what stored sessions persist; normalize at resolution

## Evidence

- `RESOURCE_FREE_TARGET_ID` normalization in `resolve_chat_working_context`
  (`crates/nucleus-server/src/local_codex_chat.rs`).
- Live evidence: operator accepted a plan on a transient quick chat; the
  decision settled and the record rendered, then the follow-up turn failed
  on the sentinel before this fix.
