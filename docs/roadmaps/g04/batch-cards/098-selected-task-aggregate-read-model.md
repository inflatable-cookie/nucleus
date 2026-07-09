# 098 Selected Task Aggregate Read Model

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../020-selected-task-product-aggregate-query.md`

## Purpose

Implement the server-owned selected-task aggregate read model.

## Work

- [x] Add aggregate domain type in focused server modules.
- [x] Compose from existing selected-task workflow sources.
- [x] Keep source records sanitized and read-only.
- [x] Add focused tests for blockers, next action, evidence, review, route,
  rework, completion, and SCM groups.

## Acceptance Criteria

- [x] No mutation or provider/SCM effects are introduced.
- [x] Aggregate output is deterministic for seeded local state.
- [x] Tests cover missing-source and blocked states.

## Result

Added `crates/nucleus-server/src/selected_task_product_aggregate/` as a pure
read model with focused `types`, `builder`, and tests.

The aggregate accepts existing selected-task sources and returns grouped
product state for identity, next action, readiness, command previews, work
evidence, review, rework, completion, SCM handoff, source health, and gaps.
