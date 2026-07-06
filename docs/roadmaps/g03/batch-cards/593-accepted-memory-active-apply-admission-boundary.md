# 593 Accepted Memory Active Apply Admission Boundary

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../135-accepted-memory-review-receipt-persistence-and-apply-admission.md`

## Purpose

Define stopped active-apply admission records over durable approved review
receipts.

## Work

- [x] Define active-apply admission inputs and receipts.
- [x] Require durable approved review receipt refs.
- [x] Require exact apply admission, import admission, conflict, candidate,
  memory, file, provenance, and evidence refs.
- [x] Block deferred, rejected, blocked, duplicate, missing-ref, stale, and
  effect-widened review states.
- [x] Keep active accepted-memory mutation executor out of scope.

## Acceptance Criteria

- [x] Active-apply admission cannot be granted from synthetic diagnostics
  receipts.
- [x] Active-apply admission cannot be granted from deferred/rejected/blocked
  review receipts.
- [x] Active-apply admission records preserve sanitized refs and no-effect
  flags.
- [x] No accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.

## Boundary Result

Stopped active-apply admissions are represented by
`AcceptedMemoryActiveApplyAdmissionInput`, `AcceptedMemoryActiveApplyAdmissionRecord`,
and `AcceptedMemoryActiveApplyAdmissionSet` in `nucleus-server`.

The boundary consumes durable `AcceptedMemoryReviewReceiptStorageRecord`
records, not synthetic diagnostics receipts. Admission requires an approved
durable review receipt with admitted source apply/admission state and exact
apply, import, conflict, candidate, memory, file, provenance, and evidence refs.

Deferred, rejected, blocked, duplicate/no-op, stale-ref, missing-ref,
raw-payload, and effect-widened states are blocked. The records preserve
sanitized refs and no-effect flags only; they perform no active accepted-memory
mutation, projection write, SCM/forge mutation, embeddings/search, provider
sync, automatic extraction, task mutation, agent scheduling, or UI behavior.
