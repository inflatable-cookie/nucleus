# 546 Planning Import Active Apply Diagnostics Query CLI Effigy

Status: planned
Owner: Tom
Updated: 2026-07-03
Milestone: `../124-planning-import-active-apply-admission.md`

## Purpose

Expose read-only diagnostics for active-apply admission records.

## Work

- [ ] Add server query/control DTO support.
- [ ] Add `nucleusd query` rendering.
- [ ] Add an Effigy selector.
- [ ] Add focused tests.

## Acceptance Criteria

- [ ] Diagnostics report admitted, blocked, duplicate no-op, stale, conflict,
  unsupported, and repair-required counts.
- [ ] Diagnostics report no-effect flags.
- [ ] Diagnostics do not expose raw payloads, private planning bodies, secrets,
  provider payloads, or source bodies.
- [ ] Diagnostics do not mutate planning records.
