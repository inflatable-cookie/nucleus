# 545 Planning Import Active Apply Admission Persistence

Status: completed
Owner: Tom
Updated: 2026-07-04
Milestone: `../124-planning-import-active-apply-admission.md`

## Purpose

Persist active-apply admission records without executing apply.

## Work

- [x] Store admission records under the planning state boundary.
- [x] Use duplicate no-op handling for repeated admission ids.
- [x] Preserve revision expectations, approval refs, and sanitized evidence refs.
- [x] Reject or withhold persistence for blocked/effect-widened records.

## Acceptance Criteria

- [x] Admission records can be replayed/queried later.
- [x] Active planning records are not mutated.
- [x] Raw projected file payloads and private planning bodies are not retained.
