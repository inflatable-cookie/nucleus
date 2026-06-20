# 077 Codex Runtime Observation Event Store Linkage

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Promote accepted provider observations into orchestration event-store records
with deterministic identity and idempotent ingestion.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/076-codex-provider-session-and-stdio-persistence.md`

## Goals

- [x] Define runtime observation event identity.
- [x] Add idempotent ingestion cursor records.
- [x] Persist accepted observation events.
- [x] Rebuild observation projections from persisted events.
- [x] Keep replay free of provider process execution.

## Execution Plan

- [x] Identity batch: define observation/event ids.
- [x] Cursor batch: reject duplicate or out-of-order observations.
- [x] Persistence batch: write accepted observations to the event store.
- [x] Replay batch: rebuild projections from observation events.
- [x] Closeout batch: validate and activate task-transition admission.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/349-runtime-observation-event-identity.md`
- `batch-cards/350-idempotent-observation-ingestion-cursor.md`
- `batch-cards/351-runtime-observation-event-store-persistence.md`
- `batch-cards/352-runtime-observation-replay-projection.md`
- `batch-cards/353-runtime-observation-linkage-validation-closeout.md`

## Acceptance Criteria

- [x] Accepted observations have stable ids and evidence refs.
- [x] Duplicate observations are deterministic no-ops or blocked records.
- [x] Replay rebuilds state without provider I/O.
- [x] Validation passes or blockers are recorded.
