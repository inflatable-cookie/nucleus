# 599 Accepted Memory Active Apply Diagnostics Control

Status: planned
Owner: Tom
Updated: 2026-07-06
Milestone: `../136-accepted-memory-active-apply-executor-boundary.md`

## Purpose

Expose active apply executor results through read-only diagnostics.

## Work

- [ ] Add server query/read model for active-apply receipts.
- [ ] Add control-envelope DTO conversion.
- [ ] Add `nucleusd query` output.
- [ ] Add Effigy selector if stable.
- [ ] Add focused server, DTO, CLI, and selector tests.

## Acceptance Criteria

- [ ] Diagnostics distinguish applied, duplicate no-op, blocked, stale,
  missing-ref, conflict, and effect-widened states.
- [ ] Diagnostics expose refs and counts without raw payloads.
- [ ] Diagnostics do not trigger apply, projection, SCM/forge, search/provider,
  extraction, task, agent, callback/interruption/recovery, or UI effects.
