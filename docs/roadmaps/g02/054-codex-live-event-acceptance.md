# 054 Codex Live Event Acceptance

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Implement the first narrow live Codex runtime acceptance path.

This lane should turn decoded Codex app-server observations into durable
Nucleus-owned records without broadening provider command execution.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add durable Codex session binding and ingestion source records.
- [x] Define idempotent provider-frame acceptance before event-store append.
- [x] Persist accepted canonical runtime event refs and unsupported observation
      refs.
- [x] Link accepted observations to task work items and sanitized receipts
      without mutating task state directly.
- [x] Expose read-only diagnostics/query state for accepted, duplicated,
      unsupported, and recovery-required observations.

## Non-Goals

- Do not spawn a real Codex process yet.
- Do not answer provider callbacks yet.
- Do not implement provider-reaching cancellation yet.
- Do not resume provider sessions after restart yet.
- Do not add UI panels.
- Do not widen SCM or forge behavior.

## Execution Plan

- [x] Record batch: introduce Codex session binding and ingestion source types.
- [x] Idempotency batch: define frame keys, duplicate handling, and recovery
      states.
- [x] Orchestration batch: map accepted observations to event-store envelopes
      and runtime receipt refs.
- [x] Task linkage batch: expose task-work links without direct task mutation.
- [x] Diagnostics batch: add read-only query/projection state.
- [x] Closeout batch: validate, update gap indexes, and select the next gate.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/235-codex-session-binding-records.md`
- `batch-cards/236-codex-ingestion-idempotency.md`
- `batch-cards/237-codex-observation-event-store-linkage.md`
- `batch-cards/238-codex-task-runtime-observation-links.md`
- `batch-cards/239-codex-ingestion-diagnostics-query.md`
- `batch-cards/240-codex-live-event-acceptance-closeout.md`

## Acceptance Criteria

- [x] Codex session binding records preserve Nucleus and provider ids.
- [x] Ingestion source records can distinguish accepted, duplicated,
      unsupported, and recovery-required observations.
- [x] Accepted observations produce event-store or receipt refs without
      retaining raw provider payloads by default.
- [x] Task work-item linkage remains reference-only and engine-owned.
- [x] `cargo check --workspace` passes.
- [x] `effigy qa:docs` and `effigy qa:northstar` pass.

## Result

The first Codex live event acceptance lane is complete as record, projection,
and diagnostics work.

Implemented:

- server-owned Codex session binding records
- decoded-frame ingestion source records
- duplicate-safe frame acceptance records
- runtime-observation event-store linkage records
- reference-only task work-item observation links
- read-only Codex ingestion diagnostics DTOs

Not implemented:

- Codex process spawning
- stdio transport
- live JSON-RPC decoding
- provider callback responses
- provider-reaching cancellation
- provider resume/recovery execution
- automatic task state mutation

Next gate: `055-codex-process-and-transport-acceptance.md`.

## Gate

Provider process spawning and provider command execution remain blocked until
this lane proves durable event acceptance and recovery visibility.
