# 2026-07-20 Swallowtail Codex Smoke Consolidation

## Decision

The separately confirmed `nucleusd` Codex smoke now uses a narrow read-only
diagnostic runner in `nucleus-agent-adapters` over Swallowtail. Nucleus's second
Codex process and JSON-RPC implementation is removed.

The smoke remains distinct from Agent Chat and `TaskExecutionRuntime`. The
daemon still requires its explicit CLI confirmation before provider work and
the adapter receives no task tools or writable access.

## Evidence Comparison

The durable smoke record needs safe provider thread/turn refs, a terminal
classification, observation counts, semantic lifecycle milestones, and cleanup
certainty. Swallowtail supplies:

- provider session and turn refs
- normalized event and provider-request streams
- completed, timeout, provider, host, runtime, and provider-request terminal
  states
- terminal, turn, and session cleanup outcomes

The legacy `notification_count` field receives the normalized event count. The
method sequence is a compatibility projection of completed Swallowtail session
operations; raw JSON-RPC frames are neither observed nor retained.

## Removed

- the daemon-owned `codex app-server` spawn path
- the daemon-owned line-based JSON-RPC request/notification loop
- the direct response-field decoder

## Validation

- 15 `nucleus-agent-adapters` tests passed
- 89 `nucleusd` tests passed
- isolated-target compile passed
- adapter and daemon no longer contain a direct `codex app-server` spawn or
  JSON-RPC client

## Next

Run authenticated single-task and ordered two-task Goal execution through the
native app. Confirm review-ready diff evidence, waiting/failure/recovery
inspection, UI responsiveness, and the absence of unapproved direct transport.
