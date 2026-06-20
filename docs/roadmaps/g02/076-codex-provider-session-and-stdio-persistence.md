# 076 Codex Provider Session And Stdio Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Persist provider session, stdio frame, decode, and transport receipt evidence
so live Codex runtime state can survive restart and be replayed.

This lane follows durable dispatch invocation. It should not add new provider
authority; it should make already accepted runtime facts durable.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/075-codex-durable-dispatch-invocation-gate.md`

## Goals

- [x] Persist provider session binding records.
- [x] Persist sanitized stdio frame source records.
- [x] Persist decode outcome records without raw payload retention.
- [x] Expose transport receipt read models.
- [x] Keep provider writes and task mutation outside persistence.

## Execution Plan

- [x] Session batch: persist provider session bindings.
- [x] Frame batch: persist bounded stdio frame metadata.
- [x] Decode batch: persist decode outcomes and unsupported-frame evidence.
- [x] Receipt batch: expose transport receipt read models.
- [x] Closeout batch: validate and activate runtime observation linkage.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/344-provider-session-persistence-records.md`
- `batch-cards/345-stdio-frame-source-persistence.md`
- `batch-cards/346-decode-outcome-persistence.md`
- `batch-cards/347-transport-receipt-read-model.md`
- `batch-cards/348-provider-session-stdio-validation-closeout.md`

## Acceptance Criteria

- [x] Session and frame evidence survives local-store reopen.
- [x] Decode records are replayable without raw provider material.
- [x] Transport receipts are read-only and sanitized.
- [x] Validation passes or blockers are recorded.
