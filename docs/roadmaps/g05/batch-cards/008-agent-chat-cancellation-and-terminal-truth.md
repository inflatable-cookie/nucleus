# 008 Agent Chat Cancellation And Terminal Truth

Status: completed
Owner: Tom
Updated: 2026-07-25
Milestone: `../003-swallowtail-application-proof-readiness.md`
Auto-start next card: yes

## Objective

Cancel the active native Agent Chat turn without waiting for the serialized
chat mutex, then persist its exact terminal outcome.

## Governing Refs

- Contract 010
- Contract 030
- roadmap g05.003

## Scope

1. Add a provider-neutral, thread-safe turn cancellation signal to the Nucleus
   live runtime request.
2. Wake the active adapter turn loop when cancellation is requested.
3. Request cancellation through the active Swallowtail turn handle.
4. Add a project-and-conversation-scoped active-turn registry outside the chat
   service mutex.
5. Add one Tauri cancellation command and matching TypeScript helper.
6. Show one Cancel action only while Agent Chat is sending.
7. Persist `cancelled`, `timed_out`, `failed`, and `completed` distinctly.
8. Keep cleanup joined and surface cleanup failure without converting it into
   successful cancellation.

## Acceptance

- [x] cancellation can be requested while `send_agent_chat_message` is blocked
- [x] a request for another project or inactive conversation performs no effect
- [x] cancellation request is not treated as terminal completion
- [x] Swallowtail terminal cancellation and deadline map to distinct records
- [x] normal completion and tool callbacks retain current behavior
- [x] no provider id, prompt, output, or raw error enters stable diagnostics

## Validation

- focused protocol, adapter, server, Tauri, and client tests
- `effigy desktop:check`
- `effigy desktop:test`
- `git diff --check`

## Evidence

- A provider-neutral cancellation signal wakes the adapter poll loop.
- The desktop registry is outside the chat mutex and targets exact project and
  conversation identity.
- Typed cancelled, timed-out, cleanup-failed, and other failure outcomes reach
  explicit durable statuses without string matching.
- Focused protocol, adapter, server, desktop, and client tests pass. No
  provider call occurred.

## Stop Conditions

- cancellation needs the chat mutex held by the active send
- the implementation detaches a worker or relies on process drop
- string matching is used to infer terminal status
- current thread-rename changes cannot be preserved cleanly
