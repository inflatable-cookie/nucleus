# 546 Planning Import Active Apply Diagnostics Query CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-04
Milestone: `../124-planning-import-active-apply-admission.md`

## Purpose

Expose read-only diagnostics for active-apply admission records.

## Work

- [x] Add server query/control DTO support.
- [x] Add `nucleusd query` rendering.
- [x] Add an Effigy selector.
- [x] Add focused tests.

## Acceptance Criteria

- [x] Diagnostics report admitted, blocked, duplicate no-op, stale, conflict,
  unsupported, and repair-required counts.
- [x] Diagnostics report no-effect flags.
- [x] Diagnostics do not expose raw payloads, private planning bodies, secrets,
  provider payloads, or source bodies.
- [x] Diagnostics do not mutate planning records.
