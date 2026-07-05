# 551 Planning Import Active Apply Executor Diagnostics Query CLI Effigy

Status: paused
Owner: Tom
Updated: 2026-07-04
Milestone: `../125-planning-import-active-apply-executor-boundary.md`

## Purpose

Expose read-only diagnostics for stopped executor records.

## Work

- [ ] Add server query/control DTO support.
- [ ] Add `nucleusd query` rendering.
- [ ] Add an Effigy selector.
- [ ] Add focused tests.

## Acceptance Criteria

- [ ] Diagnostics report admitted, blocked, duplicate no-op, stale, conflict,
  unsupported, repair-required, and missing-ref counts.
- [ ] Diagnostics report no-effect flags.
- [ ] Diagnostics do not expose raw payloads, private planning bodies, secrets,
  provider payloads, or source bodies.
- [ ] Diagnostics do not mutate planning records.

## Pause Note

Paused with the executor persistence card. Resume only if the minimum apply
proof shows that additional executor diagnostics are worth building.
