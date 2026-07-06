# 598 Accepted Memory Active Apply Receipts Idempotency

Status: planned
Owner: Tom
Updated: 2026-07-06
Milestone: `../136-accepted-memory-active-apply-executor-boundary.md`

## Purpose

Persist sanitized active-apply receipts and idempotency outcomes.

## Work

- [ ] Define active-apply receipt storage shape.
- [ ] Persist applied, duplicate no-op, and blocked receipt outcomes.
- [ ] Detect conflicting duplicate receipts.
- [ ] Keep receipt payloads sanitized and ref-based.
- [ ] Add focused codec and persistence tests.

## Acceptance Criteria

- [ ] Apply receipts are durable, sanitized, and distinct from review receipts.
- [ ] Duplicate no-op and conflict behavior is deterministic.
- [ ] Receipts do not contain raw transcripts, provider payloads, terminal
  streams, credentials, private notes, or unmanaged memory bodies.
