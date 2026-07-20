# 196 Transient Chat Validation

Status: completed
Owner: Tom
Updated: 2026-07-20
Milestone: `../040-transient-chat-and-promotion.md`
Auto-start next card: no

## Objective

Validate transient creation, active-turn protection, restart, expiry,
promotion, and durable-child safeguards.

## Acceptance

- [x] lifecycle, persistence, chat, desktop, and docs checks pass
- [x] resource-free chat uses the host home without exposing an invented
  filesystem resource
- [x] promoted chats retain project, conversation, session, and message
  continuity
- [x] operator confirms New chat is immediate and uncluttered

## Validation Evidence

- transient projects survive restart until explicitly expired
- an active chat turn blocks expiry until the turn becomes terminal
- expiry cannot win between turn persistence and provider submission: chat
  rechecks project presence before starting provider work
- task creation, Goal creation, and resource attachment promote the same project
  in place
- resource-free chat resolves to host home with `resource:none`
- focused server and desktop checks pass

## Operator Check

Click New chat and confirm it opens immediately without a dialog, appears in
the Chats group, and shows the normal composer without resource controls. Keep
or name it and confirm the same visible conversation remains.

Confirmed by the operator on 2026-07-20.
