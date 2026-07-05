# 588 Accepted Memory Import Apply Review Command Model

Status: planned
Owner: Tom
Updated: 2026-07-05
Milestone: `../134-accepted-memory-import-apply-review-commands.md`

## Purpose

Implement sanitized review command inputs and receipts for accepted-memory
import-apply admissions.

## Work

- [ ] Add review command input, decision, receipt, status, blocker, and counts
  types.
- [ ] Validate approve, defer, and reject decisions against stopped
  apply/admission records.
- [ ] Preserve refs without storing raw memory bodies or projection payloads.
- [ ] Add focused model tests.

## Acceptance Criteria

- [ ] Approved receipts require operator and approval refs.
- [ ] Deferred and rejected receipts preserve reason/evidence refs.
- [ ] Unsafe approvals are blocked.
- [ ] No active accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.
