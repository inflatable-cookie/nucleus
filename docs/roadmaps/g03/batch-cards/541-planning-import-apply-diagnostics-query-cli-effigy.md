# 541 Planning Import Apply Diagnostics Query CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../123-planning-projection-import-review-apply.md`

## Purpose

Expose read-only diagnostics for planning import apply readiness and stopped
apply records.

## Work

- [x] Add a server query/control DTO for apply diagnostics.
- [x] Add `nucleusd query` rendering.
- [x] Add an Effigy selector.
- [x] Add focused tests.

## Acceptance Criteria

- [x] Diagnostics report ready, blocked, conflict, stale, duplicate no-op, and
  repair-required counts.
- [x] Diagnostics report no-effect flags.
- [x] Diagnostics do not expose raw payloads, private planning bodies, secrets,
  provider payloads, or source bodies.
- [x] Diagnostics do not mutate planning records.
