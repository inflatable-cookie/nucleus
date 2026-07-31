# 020 Typed Question Desktop Composition

Status: completed
Owner: Tom
Created: 2026-07-31
Milestone: `../006-interactive-agent-chat-sessions.md`
Depends on: card 019
Auto-start next card: yes

## Objective

Expose the pending typed exchange through IPC and Poodle's question composition.

## Acceptance

- [x] `AgentChatInput` enters questioning state
- [x] `AgentQuestion` occupies the composer question slot
- [x] free text acts as the Poodle override
- [x] submit routes an answer instead of an ordinary message
- [x] answered questions replay through `AgentQuestionRecord`
- [x] scrolling, panel switching, and cancellation remain available

## Evidence

- Agent Chat hydrates and listens for durable typed exchanges, routes answers
  through the dedicated Tauri command, and leaves cancellation independent.
- Poodle transcript fixtures cover answered secret questions and restarted
  unanswered questions without exposing an answer affordance.
