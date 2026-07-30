# 017 Observable Chat Native Acceptance

Status: completed
Owner: Tom
Created: 2026-07-30
Milestone: `../005-observable-agent-chat-transcript.md`
Depends on: card 016
Auto-start next card: no

## Objective

Validate the real transcript shape and one authenticated Codex turn through the
normal desktop path.

## Acceptance

- [x] operator-authorized native inspection confirms intermediate messages
      remain readable
- [x] operator-authorized native inspection confirms consecutive work
      collapses and expands cleanly
- [x] operator-authorized native inspection confirms long output does not
      steal scroll position
- [x] one authenticated turn shows activity and unchanged final output
- [x] cancellation remains responsive during visible activity

## Native Evidence

- 2026-07-30: rebuilt the current debug app bundle and opened it through the
  normal macOS application path
- the empty Agent Chat state and the stored 18-turn Nucleus Local transcript
  rendered through `AgentTranscript`
- stored user and assistant messages remained readable
- scrolling away from the end preserved position and exposed `Jump to latest`
  instead of snapping back to the composer
- the stored thread predates durable activity observations, so tool grouping,
  authenticated activity, final-output parity, and cancellation required the
  separately approved live pass
- one read-only turn displayed a reasoning summary, one grouped command, its
  bounded output, and the exact final reply
- the group and command output both expanded and collapsed cleanly
- a second turn ran `sleep 20`; cancellation returned in about 1.2 seconds,
  retained visible activity, omitted the forbidden completion reply, and
  joined the child process
- restart inspection exposed a stale in-progress tool row after cancellation
- Nucleus now carries sanitized durable turn status in history, settles that
  display row without synthesizing Swallowtail activity, and shows `Turn
  cancelled`
- the repaired bundle passed restart inspection without another provider call

## Stop Conditions

- do not run authenticated work without operator approval
- visual failure returns to card 015 without changing Poodle contracts locally
