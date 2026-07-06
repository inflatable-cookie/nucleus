# 589 Accepted Memory Import Apply Review Diagnostics Control

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../134-accepted-memory-import-apply-review-commands.md`

## Purpose

Expose accepted-memory import-apply review receipt diagnostics through
read-only control surfaces.

## Work

- [x] Add server query/read model over review receipts.
- [x] Add control-envelope DTO conversion.
- [x] Add `nucleusd query` output.
- [x] Add Effigy selector if stable.
- [x] Add focused server, DTO, CLI, and selector tests.

## Acceptance Criteria

- [x] Diagnostics distinguish approved, deferred, rejected, blocked, duplicate,
  conflict, and approval-required review states.
- [x] Diagnostics expose refs and counts without raw memory bodies.
- [x] No active accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.

## Implementation Result

Added read-only accepted-memory import-apply review diagnostics through:

- `AcceptedMemoryImportApplyReviewDiagnostics`
- `ServerQueryKind::AcceptedMemoryImportApplyReviewDiagnostics`
- control-envelope request/response DTO conversion
- `nucleusd query accepted-memory-import-apply-review-diagnostics --project <project-id>`
- Effigy selector `server:query:accepted-memory-import-apply-review-diagnostics`

Diagnostics synthesize sanitized review-command validation receipts from
stopped import-apply admissions. They expose receipt refs, command refs,
admission refs, decision/status counts, duplicate/conflict/approval-required
counts, blockers, provenance refs, and evidence refs without raw memory bodies.

No review receipts are persisted. No active accepted-memory apply, projection
write, SCM/forge mutation, embeddings/search, provider-native memory sync,
automatic extraction, task mutation, agent scheduling, or final UI behavior is
performed.
