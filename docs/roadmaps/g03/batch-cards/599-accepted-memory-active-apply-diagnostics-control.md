# 599 Accepted Memory Active Apply Diagnostics Control

Status: superseded
Owner: Tom
Updated: 2026-07-06
Milestone: `../136-accepted-memory-active-apply-executor-boundary.md`

## Purpose

Expose active apply executor results through read-only diagnostics.

## Superseded Reason

Deferred by `../../g04/001-product-workflow-rebaseline-and-vertical-slice.md`.
Diagnostics for active apply should follow a real executor need, not extend
the current accepted-memory proof chain by momentum.

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
