# 019 Typed Question Rendezvous And Persistence

Status: completed
Owner: Tom
Created: 2026-07-31
Milestone: `../006-interactive-agent-chat-sessions.md`
Depends on: card 018
Auto-start next card: yes

## Objective

Persist a portable pending question and resolve its original callback responder
through a separately routed, exact-once answer.

## Acceptance

- [x] the waiting turn holds no mutex required by the answer route
- [x] callback, operation, turn, provider-request, sequence, and deadline
      correlation survive persistence
- [x] response validation is delegated to Swallowtail's portable request
- [x] duplicate, stale, cancelled, timed-out, terminal, and restart cases are
      deterministic
- [x] secret response content is not persisted

## Evidence

- `nucleus-agent-protocol::AgentUserInputWait` splits the turn wait from a
  weak, exact-once answer route.
- `local_codex_chat::questions` keeps the registry outside the serialized chat
  service and validates the complete portable request before persistence and
  wakeup.
- deterministic registry, secret-redaction, terminal-settlement, and restart
  fixtures pass.
