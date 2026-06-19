# 054 Codex Live Event Acceptance

Status: active
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

- [ ] Add durable Codex session binding and ingestion source records.
- [ ] Define idempotent provider-frame acceptance before event-store append.
- [ ] Persist accepted canonical runtime event refs and unsupported observation
      refs.
- [ ] Link accepted observations to task work items and sanitized receipts
      without mutating task state directly.
- [ ] Expose read-only diagnostics/query state for accepted, duplicated,
      unsupported, and recovery-required observations.

## Non-Goals

- Do not spawn a real Codex process yet.
- Do not answer provider callbacks yet.
- Do not implement provider-reaching cancellation yet.
- Do not resume provider sessions after restart yet.
- Do not add UI panels.
- Do not widen SCM or forge behavior.

## Execution Plan

- [ ] Record batch: introduce Codex session binding and ingestion source types.
- [ ] Idempotency batch: define frame keys, duplicate handling, and recovery
      states.
- [ ] Orchestration batch: map accepted observations to event-store envelopes
      and runtime receipt refs.
- [ ] Task linkage batch: expose task-work links without direct task mutation.
- [ ] Diagnostics batch: add read-only query/projection state.
- [ ] Closeout batch: validate, update gap indexes, and select the next gate.

## Batch Cards

Ready cards:

- `batch-cards/235-codex-session-binding-records.md`

Planned cards:

- `batch-cards/236-codex-ingestion-idempotency.md`
- `batch-cards/237-codex-observation-event-store-linkage.md`
- `batch-cards/238-codex-task-runtime-observation-links.md`
- `batch-cards/239-codex-ingestion-diagnostics-query.md`
- `batch-cards/240-codex-live-event-acceptance-closeout.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] Codex session binding records preserve Nucleus and provider ids.
- [ ] Ingestion source records can distinguish accepted, duplicated,
      unsupported, and recovery-required observations.
- [ ] Accepted observations produce event-store or receipt refs without
      retaining raw provider payloads by default.
- [ ] Task work-item linkage remains reference-only and engine-owned.
- [ ] `cargo check --workspace` passes.
- [ ] `effigy qa:docs` and `effigy qa:northstar` pass.

## Gate

Provider process spawning and provider command execution remain blocked until
this lane proves durable event acceptance and recovery visibility.
