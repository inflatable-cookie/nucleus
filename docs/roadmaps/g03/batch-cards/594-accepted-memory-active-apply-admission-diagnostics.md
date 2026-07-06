# 594 Accepted Memory Active Apply Admission Diagnostics

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../135-accepted-memory-review-receipt-persistence-and-apply-admission.md`

## Purpose

Expose stopped active-apply admission diagnostics through read-only control
surfaces.

## Work

- [x] Add server query/read model over active-apply admission records.
- [x] Add control-envelope DTO conversion.
- [x] Add `nucleusd query` output.
- [x] Add Effigy selector if stable.
- [x] Add focused server, DTO, CLI, and selector tests.

## Acceptance Criteria

- [x] Diagnostics distinguish admitted, blocked, duplicate, stale,
  review-missing, review-rejected, review-deferred, and review-blocked states.
- [x] Diagnostics expose refs and counts without raw memory bodies.
- [x] No accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.

## Boundary Result

Completed stopped active-apply diagnostics as a read-only state-backed query,
control-envelope request/response DTO, `nucleusd query
accepted-memory-active-apply-diagnostics`, and Effigy selector.

The query consumes persisted sanitized review receipts and unsupported
shared-memory records. It reports admitted, duplicate no-op, blocked, blocker
bucket, skipped-record, and no-effect counts. It does not apply accepted
memory, write projection files, call SCM/forge, run embeddings/search, sync
provider-native memory, extract memories, mutate tasks, schedule agents, or
drive UI behavior.
