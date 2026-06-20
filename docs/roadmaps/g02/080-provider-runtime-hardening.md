# 080 Provider Runtime Hardening

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Harden provider runtime retry, idempotency, backpressure, retention, and repair
paths before broadening automation.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/079-durable-wait-callback-interruption-recovery-persistence.md`

## Goals

- [x] Add provider idempotency ledger records.
- [x] Add retry and reconciliation records.
- [x] Add high-volume stream/backpressure summary records.
- [x] Enforce provider retention policy at record boundaries.
- [x] Add repair records for uncertain runtime state.

## Execution Plan

- [x] Idempotency batch.
- [x] Retry/reconciliation batch.
- [x] Backpressure batch.
- [x] Retention batch.
- [x] Repair batch and closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/364-provider-idempotency-ledger.md`
- `batch-cards/365-provider-retry-reconciliation-records.md`
- `batch-cards/366-provider-backpressure-summary-records.md`
- `batch-cards/367-provider-retention-policy-enforcement.md`
- `batch-cards/368-provider-runtime-repair-records.md`

## Acceptance Criteria

- [x] Duplicate effects reconcile without duplicate provider writes.
- [x] High-volume streams have bounded summaries.
- [x] Raw payload retention is blocked by default.
- [x] Repair requirements are explicit and inspectable.
