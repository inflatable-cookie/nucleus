# 561 Accepted Memory Read Projection

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../128-accepted-memory-read-only-inspection.md`

## Purpose

Create a sanitized read model for accepted-memory storage records.

## Work

- [x] Add a pure accepted-memory projection in `nucleus-server`.
- [x] Summarize accepted-memory records by id, scope, kind, status,
  sensitivity, retention, confidence, source/link counts, and proposal refs.
- [x] Count skipped or unsupported records without exposing raw payloads.
- [x] Keep storage mutation, projection files, embeddings, search, provider
  sync, task mutation, SCM/forge mutation, and UI out of scope.

## Acceptance Criteria

- [x] Projection tests cover project-scoped accepted-memory records.
- [x] Proposal records do not appear as accepted memory.
- [x] Projection output contains refs and counts, not raw memory bodies or
  private payloads.

## Result

Added a pure accepted-memory projection in `nucleus-server`.

The projection summarizes accepted-memory storage records by stable memory id,
source proposal id, scope, kind, status, sensitivity, retention, confidence,
actor/reviewer refs, source/link/evidence counts, and supersession counts.

Query-side skipped categories are represented without raw payloads:

- proposal records skipped
- unsupported records skipped
- decode failures skipped

No storage mutation, projection file write, embedding, search, provider sync,
task mutation, SCM/forge mutation, or UI behavior was added.
