# 264 Provider Read-Intent Query Tests

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../070-provider-read-intent-query-composition.md`

## Purpose

Prove the provider read-intent query composes local-store records into the
generic projection.

## Acceptance Criteria

- [x] Store-backed source records produce a mixed-family projection.
- [x] Empty stores produce empty projections.
- [x] Control DTO serializes sanitized counts only.
- [x] Test fixtures stay split by source family.
