# 591 Accepted Memory Review Receipt Persistence Boundary

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../135-accepted-memory-review-receipt-persistence-and-apply-admission.md`

## Purpose

Define the durable storage boundary for accepted-memory import-apply review
receipts.

## Work

- [x] Define persisted review receipt identity and required refs.
- [x] Define persisted decision/status/blocker vocabulary.
- [x] Define which review receipt fields are storage authority and which remain
  diagnostics-only.
- [x] Confirm raw memory bodies, projection payloads, provider payloads,
  transcripts, terminal streams, credentials, and private notes are excluded.
- [x] Confirm persistence grants no active apply authority by itself.

## Acceptance Criteria

- [x] Durable review receipts are distinct from synthetic diagnostics receipts
  and active apply receipts.
- [x] Approved, deferred, rejected, and blocked receipts can be represented.
- [x] Required operator, approval/reason, admission, candidate, memory, file,
  provenance, and evidence refs are explicit.
- [x] No accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.

## Boundary Result

Durable accepted-memory import-apply review receipt storage is represented by
`AcceptedMemoryReviewReceiptStorageRecord` in `nucleus-memory`.

Storage authority:

- `review_receipt_id`
- `project_id`
- `command_id`
- `operator_ref`
- `approval_ref` for approved decisions
- `decision_reason_ref` for deferred or rejected decisions
- apply admission, import admission, conflict, candidate, memory, and file refs
- sanitized provenance and evidence refs
- persisted decision, receipt status, source admission status, review blockers,
  and source admission blockers
- optional reviewed/updated timestamps

Diagnostics-only state:

- receipt synthesis source
- no-effect flags
- query counters
- UI/readiness presentation buckets

The local-store kind `SharedMemoryReviewReceipt` is reserved for these records
so persisted receipts do not masquerade as accepted-memory or memory-proposal
payloads. The storage codec excludes raw memory bodies, projection payloads,
provider payloads, raw transcripts, terminal streams, credentials, secret
values, and private notes. Storage records grant no active apply, projection
write, SCM/forge, embeddings/search, provider sync, extraction, task, agent, or
UI authority.
