# 020 Runtime Receipt Contract

Status: draft
Owner: Tom
Updated: 2026-06-17

## Purpose

Define durable receipts for runtime work and side effects.

Receipts record what was requested, accepted, started, progressed, completed,
failed, cancelled, retried, or recovered. They let clients and projections show
truthful state without owning execution.

## Receipt Rule

Every orchestrated side effect should produce receipts.

Receipts are not raw logs. They are structured evidence records linked to
commands, events, actors, authority hosts, and artifacts.

## Initial Receipt Families

- command execution
- harness/provider runtime
- tool call
- SCM/forge operation
- checkpoint/diff operation
- planning operation
- research operation
- memory operation
- Effigy operation
- steward/native harness operation
- host/client auth operation
- custom

## Receipt Fields

Minimum fields:

- receipt id
- receipt family
- command id or causal event id
- authority host id
- actor ref
- target workflow ref
- status
- started timestamp when known
- finished timestamp when known
- sanitized summary
- evidence refs
- artifact refs
- retry refs
- cancellation refs
- recovery refs

## First Runtime Receipt Implementation

The first implementation covers read-only command execution.

Implemented records carry:

- receipt id
- effect family
- status
- command ref
- effect/request ref
- command evidence refs
- artifact refs
- sanitized summary

The server stores these records in the runtime effects state domain. They are
queryable through runtime metadata as typed runtime receipt records.

The first reactor maps the existing read-only command control result to a
runtime receipt after sanitized command evidence is persisted.

The first projection/query reads receipt records. It must not re-run command
execution.

## Status Rule

Initial receipt statuses:

- accepted
- queued
- started
- in progress
- waiting for approval
- waiting for user input
- blocked
- completed
- completed with warnings
- cancelled
- failed
- recovery required
- recovered
- unknown

Unsupported or unknown provider states must stay visible. They must not be
collapsed into success or failure just to simplify UI rendering.

## Progress Event Rule

Long-running effects may emit progress events.

Progress events are durable when they affect recovery, audit, timeline,
projection, or user-visible state. High-volume raw streams may be stored as
artifacts or summarized by policy.

Progress events must identify:

- receipt id
- progress event id
- sequence within receipt
- progress kind
- sanitized summary
- evidence refs
- artifact refs

## Sanitization Rule

Receipts are client-safe by default.

They must not expose:

- raw secrets
- raw provider credentials
- raw authorization headers
- raw unbounded stdout or stderr
- full terminal streams
- full provider payloads
- local paths that policy says should be hidden

Raw evidence belongs behind artifact policy, access checks, and retention
rules.

## Retry And Idempotency Rule

Retries must be explicit.

A retry creates a new receipt linked to the prior receipt and original command
or workflow. Idempotent command handling may avoid duplicate effects, but must
still return a receipt or reconciliation result that clients can understand.

## Replay Rule

Replay must not re-run receipts.

Receipts are evidence of side effects that already happened or were attempted.
Projection replay reads receipts and events to rebuild state; it must not spawn
commands, provider turns, SCM mutations, or network calls.

## Codex Fixture Receipt Mapping

Codex app-server interruption fixtures map to harness-provider runtime
receipts.

The first implementation is static:

- no Codex process is spawned
- no live session is opened
- no interruption request is sent
- no filesystem or SCM state is changed

The receipt projection records:

- receipt id
- harness/provider family
- status
- provider instance/session effect ref
- evidence event ref when available
- sanitized summary

Interruption/cancellation remains evidence of a provider runtime effect. It
must not be projected as a conversation message or treated as filesystem
rollback.
