# 587 Accepted Memory Import Apply Review Command Boundary

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../134-accepted-memory-import-apply-review-commands.md`

## Purpose

Define the review command boundary for stopped accepted-memory import-apply
admissions.

## Work

- [x] Define approve, defer, and reject command semantics.
- [x] Define required refs for operator, approval, admission, conflict,
  candidate, file, provenance, and evidence.
- [x] Define blockers for missing refs, unresolved conflicts, duplicate no-ops,
  raw payloads, and requested effect widening.
- [x] Confirm all active mutation and external effects stay deferred.

## Acceptance Criteria

- [x] Review command receipts are distinct from active apply receipts.
- [x] Approval cannot bypass missing operator/approval refs or unresolved
  blockers.
- [x] Deferral and rejection preserve sanitized evidence for later review.
- [x] No active accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.

## Boundary Result

Review decisions:

- approve: records operator and approval refs for a later active apply lane
- defer: records that the stopped admission remains staged
- reject: records that the stopped admission should not be applied without a
  new review

Required refs:

- command id
- operator ref
- approval ref for approve decisions
- decision reason ref for defer and reject decisions
- apply admission, import admission, conflict, candidate, memory, and file refs
- sanitized provenance and evidence refs

Blocked approval cases:

- missing command/operator/approval/provenance/evidence refs
- missing admission/conflict/candidate/memory/file refs
- stopped admission is blocked or duplicate no-op
- stopped admission has blockers
- raw payload is present
- requested active accepted-memory mutation, projection write, SCM/forge
  mutation, embeddings/search, provider sync, automatic extraction, task
  mutation, agent scheduling, or UI behavior

Review receipts are not active apply receipts.
