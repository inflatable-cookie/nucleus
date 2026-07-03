# 540 Planning Import Apply Stopped Persistence

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../123-planning-projection-import-review-apply.md`

## Purpose

Persist stopped planning import apply records without active planning mutation.

## Work

- [x] Store stopped apply records under the planning state boundary.
- [x] Use revision expectations and duplicate no-op handling.
- [x] Preserve sanitized evidence refs and dry-run summaries.
- [x] Reject records with conflicts, stale revisions, missing refs, unsupported
  schema, unsafe refs, unsupported kind, or parse failures.

## Acceptance Criteria

- [x] Stopped apply records can be replayed/queried later.
- [x] Active planning records are not mutated.
- [x] Raw projected file payloads are not retained.
