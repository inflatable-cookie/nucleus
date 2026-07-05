# 584 Accepted Memory Review Read Model Shape

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../133-accepted-memory-review-product-consumption-readiness.md`

## Purpose

Implement a read-only readiness projection over the existing accepted-memory
review/import/apply surfaces.

## Work

- [x] Add a server model that composes accepted-memory records, projection
  policy, projection write diagnostics, import validation diagnostics, and
  stopped apply/admission diagnostics.
- [x] Preserve source ids and refs for every derived readiness record.
- [x] Report ready, blocked, duplicate, conflict, repair-required, and
  approval-required states as sanitized buckets.
- [x] Keep raw memory bodies and payloads out of the read model.

## Acceptance Criteria

- [x] The read model is derived and read-only.
- [x] The read model has tests for empty state, ready records, blocked records,
  duplicate no-ops, conflict state, and approval-required state.
- [x] No active accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, or
  final UI behavior is added.

## Implementation Result

Added `AcceptedMemoryReviewReadiness`, a derived read-only projection over:

- accepted-memory read inspection
- projection/write diagnostics
- import validation diagnostics
- stopped import apply/admission diagnostics

The model emits source-tagged readiness records and aggregate counts for
accepted memory, projectability, projection write readiness, import readiness,
duplicate no-ops, conflicts, approval-required state, blockers, and evidence
refs. It sets all effect flags false.

Focused tests cover composed ready/approval-required state, duplicate no-ops,
blocked projection/import candidates, and no-effect flags.
