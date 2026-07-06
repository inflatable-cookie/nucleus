# 588 Accepted Memory Import Apply Review Command Model

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../134-accepted-memory-import-apply-review-commands.md`

## Purpose

Implement sanitized review command inputs and receipts for accepted-memory
import-apply admissions.

## Work

- [x] Add review command input, decision, receipt, status, blocker, and counts
  types.
- [x] Validate approve, defer, and reject decisions against stopped
  apply/admission records.
- [x] Preserve refs without storing raw memory bodies or projection payloads.
- [x] Add focused model tests.

## Acceptance Criteria

- [x] Approved receipts require operator and approval refs.
- [x] Deferred and rejected receipts preserve reason/evidence refs.
- [x] Unsafe approvals are blocked.
- [x] No active accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.

## Implementation Result

Added a pure `accepted_memory_import_apply_review_command` model with:

- review input, decision, receipt, status, blocker, and count types
- approved/deferred/rejected/blocked receipt statuses
- approval-only approval ref requirement
- defer/reject reason ref requirement
- missing-ref, admission-state, raw-payload, and requested-effect blockers
- no-effect flags for active memory apply, projection writes, SCM/forge,
  embeddings/search, provider sync, automatic extraction, task mutation, agent
  scheduling, and UI behavior

Focused model tests cover approval, defer/reject, duplicate-noop approval
blocking, missing refs, raw payload, requested effects, and no-effect flags.
