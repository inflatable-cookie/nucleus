# 592 Accepted Memory Review Receipt Storage Query

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../135-accepted-memory-review-receipt-persistence-and-apply-admission.md`

## Purpose

Persist sanitized accepted-memory import-apply review receipts and expose a
read-only state-backed query.

## Work

- [x] Add storage record/codec for durable review receipts.
- [x] Add persistence helpers with duplicate/no-op behavior.
- [x] Add read-only server query/read model over persisted receipts.
- [x] Add control-envelope DTO conversion.
- [x] Add `nucleusd query` output and Effigy selector if stable.
- [x] Add focused storage, query, DTO, CLI, and selector tests.

## Acceptance Criteria

- [x] Persisted receipts round-trip approved, deferred, rejected, and blocked
  decisions.
- [x] Query diagnostics expose counts and refs without raw memory bodies.
- [x] Duplicate receipt persistence is deterministic and idempotent.
- [x] No active apply, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.

## Boundary Result

Durable accepted-memory review receipts now have:

- `AcceptedMemoryReviewReceiptStorageRecord` JSON storage shape in
  `nucleus-memory`
- `SharedMemoryReviewReceipt` persistence kind in the shared-memory state
  domain
- persistence helper with deterministic duplicate/no-op behavior
- state-backed diagnostics query
  `accepted-memory-review-receipt-storage-diagnostics`
- control-envelope DTO, `nucleusd query`, and Effigy selector surfaces

Persisted receipts remain sanitized refs and counters. They grant no active
accepted-memory apply, projection write, SCM/forge effect, embeddings/search,
provider-native memory sync, automatic extraction, task mutation, agent
scheduling, or final UI authority.
