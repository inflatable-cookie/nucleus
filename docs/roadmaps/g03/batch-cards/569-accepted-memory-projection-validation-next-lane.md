# 569 Accepted Memory Projection Validation Next Lane

Status: planned
Owner: Tom
Updated: 2026-07-05
Milestone: `../129-accepted-memory-projection-policy-gate.md`

## Purpose

Validate accepted-memory projection policy and choose the next lane.

## Work

- [ ] Run focused memory/server/CLI tests.
- [ ] Run docs QA, Northstar QA, diff check, doctor, and relevant cargo check.
- [ ] Decide whether the next lane is projection file materialization,
  review controls, search planning, product consumption, or a planning
  rebaseline.

## Acceptance Criteria

- [ ] Validation passes or failures are documented.
- [ ] The next lane remains effect-gated.
- [ ] The project does not add file writes, embeddings/search/provider sync,
  task mutation, SCM/forge mutation, or final UI without a selected lane.
