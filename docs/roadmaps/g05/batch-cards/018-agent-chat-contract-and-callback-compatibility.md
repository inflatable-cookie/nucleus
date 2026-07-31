# 018 Agent Chat Contract And Callback Compatibility

Status: completed
Owner: Tom
Created: 2026-07-31
Milestone: `../006-interactive-agent-chat-sessions.md`
Depends on: card 017
Auto-start next card: yes

## Objective

Settle the durable interaction rules and restore compatibility with
Swallowtail's current typed callback variant.

## Acceptance

- [x] Contracts 010, 019, 024, and 030 own question, mode, task-list, and child
      boundaries
- [x] Agent Chat no longer references the removed callback variant
- [x] task execution recognizes typed user input and retains its explicit
      unsupported policy
- [x] `effigy check:rust` passes

## Evidence

- 2026-07-31: promoted immutable mode, exact-once question, portable task-list,
  actor, and child-topology rules into the four governing contracts
- updated both Swallowtail callback matches to `HarnessUserInput`; Agent Chat
  proceeds to card 019 rather than retaining rejection as its final behavior
- `effigy check:rust` passed; one pre-existing desktop dead-code warning remains

## Stop Conditions

- do not implement an immediate rejection in Agent Chat as the final behavior
- do not widen task execution interaction authority
