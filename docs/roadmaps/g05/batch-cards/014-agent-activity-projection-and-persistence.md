# 014 Agent Activity Projection And Persistence

Status: completed
Owner: Tom
Created: 2026-07-30
Milestone: `../005-observable-agent-chat-transcript.md`
Auto-start next card: yes

## Objective

Carry exact Swallowtail activity through the Nucleus adapter boundary into
separate durable conversation records and history.

## Scope

1. Inspect the prepared Codex activity profile before session effects.
2. Forward runtime event sequence plus `ActivityObservation`.
3. Persist bounded consumer activity DTOs under canonical conversation and
   turn identity.
4. Replay activities separately from messages.
5. Preserve callback, cancellation, terminal, and cleanup behavior.

## Acceptance

- [x] only public Swallowtail activity types cross the adapter boundary
- [x] every portable kind, lifecycle, status, content stream, disclosure, and
      correlation maps explicitly
- [x] raw provider payloads and provider activity refs are absent
- [x] activity persistence failure cancels the active turn
- [x] focused adapter and persistence tests pass

## Evidence

- prepared Codex Agent Chat requires observable activity before session open
- `AgentActivityEvent` carries only runtime sequence plus Swallowtail's public
  `ActivityObservation`
- separate activity records retain portable truth and replay through history
- focused forwarding and persistence tests pass

## Stop Conditions

- prepared Agent Chat activity is unavailable
- projection requires native Codex event parsing
- activity storage would overwrite canonical messages
