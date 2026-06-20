# 076 Codex Provider Session And Stdio Persistence

Status: planned
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

- [ ] Persist provider session binding records.
- [ ] Persist sanitized stdio frame source records.
- [ ] Persist decode outcome records without raw payload retention.
- [ ] Expose transport receipt read models.
- [ ] Keep provider writes and task mutation outside persistence.

## Execution Plan

- [ ] Session batch: persist provider session bindings.
- [ ] Frame batch: persist bounded stdio frame metadata.
- [ ] Decode batch: persist decode outcomes and unsupported-frame evidence.
- [ ] Receipt batch: expose transport receipt read models.
- [ ] Closeout batch: validate and activate runtime observation linkage.

## Batch Cards

Ready cards:

None.

Planned cards:

- `batch-cards/344-provider-session-persistence-records.md`
- `batch-cards/345-stdio-frame-source-persistence.md`
- `batch-cards/346-decode-outcome-persistence.md`
- `batch-cards/347-transport-receipt-read-model.md`
- `batch-cards/348-provider-session-stdio-validation-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] Session and frame evidence survives local-store reopen.
- [ ] Decode records are replayable without raw provider material.
- [ ] Transport receipts are read-only and sanitized.
- [ ] Validation passes or blockers are recorded.
