# 226 Nucleus Task Executor Adoption

Status: completed
Owner: Tom
Updated: 2026-07-20
Milestone: `../050-swallowtail-task-execution-adoption.md`
Auto-start next card: no

## Objective

Replace the direct task app-server transport with a Swallowtail-backed executor
behind Nucleus's existing Goal/task workflow boundary.

## Acceptance

- [x] current task prompt and host-approved resource target are preserved
- [x] started linkage persists before the provider can complete
- [x] all existing task execution outcomes map without collapse
- [x] Goal ordering, mandates, review capture, and receipts remain unchanged
- [x] direct JSON-RPC is removed from the product task executor

## Evidence

- `nucleus-agent-protocol::TaskExecutionRuntime` is the Nucleus-owned provider-
  neutral port.
- the live adapter registry resolves a separate Swallowtail task runtime by
  the admitted adapter id.
- Nucleus allocates the task session id before provider work and persists
  session/thread/turn linkage before it observes the terminal result.
- the adapter passes the existing prompt, developer instructions, model,
  reasoning, 15-minute deadline, and host-approved project root into the
  bounded Swallowtail profile.
- completion, approval wait, user-input wait, cancellation, failure, timeout,
  and cleanup uncertainty retain separate Nucleus outcomes.
- 2,001 focused protocol, adapter, and server tests pass; authenticated tests
  remain reserved for card 228.

## Stop Condition

Stop on any loss of recovery linkage, waiting state, or durable review evidence.
