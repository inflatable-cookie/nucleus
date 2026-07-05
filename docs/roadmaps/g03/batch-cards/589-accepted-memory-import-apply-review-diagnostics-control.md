# 589 Accepted Memory Import Apply Review Diagnostics Control

Status: planned
Owner: Tom
Updated: 2026-07-05
Milestone: `../134-accepted-memory-import-apply-review-commands.md`

## Purpose

Expose accepted-memory import-apply review receipt diagnostics through
read-only control surfaces.

## Work

- [ ] Add server query/read model over review receipts.
- [ ] Add control-envelope DTO conversion.
- [ ] Add `nucleusd query` output.
- [ ] Add Effigy selector if stable.
- [ ] Add focused server, DTO, CLI, and selector tests.

## Acceptance Criteria

- [ ] Diagnostics distinguish approved, deferred, rejected, blocked, duplicate,
  conflict, and approval-required review states.
- [ ] Diagnostics expose refs and counts without raw memory bodies.
- [ ] No active accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.
