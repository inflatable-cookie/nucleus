# 587 Accepted Memory Import Apply Review Command Boundary

Status: ready
Owner: Tom
Updated: 2026-07-05
Milestone: `../134-accepted-memory-import-apply-review-commands.md`

## Purpose

Define the review command boundary for stopped accepted-memory import-apply
admissions.

## Work

- [ ] Define approve, defer, and reject command semantics.
- [ ] Define required refs for operator, approval, admission, conflict,
  candidate, file, provenance, and evidence.
- [ ] Define blockers for missing refs, unresolved conflicts, duplicate no-ops,
  raw payloads, and requested effect widening.
- [ ] Confirm all active mutation and external effects stay deferred.

## Acceptance Criteria

- [ ] Review command receipts are distinct from active apply receipts.
- [ ] Approval cannot bypass missing operator/approval refs or unresolved
  blockers.
- [ ] Deferral and rejection preserve sanitized evidence for later review.
- [ ] No active accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.
