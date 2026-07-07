# 060 Selected Task Review Outcome Boundary

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../013-selected-task-review-outcome-routing.md`

## Purpose

Define the boundary for routing review decisions into the next admissible
server-owned action.

## Work

- [x] Map accepted, rejected, needs-changes, and abandoned review decisions to
  route candidates.
- [x] Define source refs for decision records, selected-task review state, task
  lifecycle state, evidence refs, receipts, and SCM handoff context.
- [x] Define blockers for missing decision records, stale task state, missing
  evidence, unsupported lifecycle state, and ambiguous operator intent.
- [x] Document no-effect rules for task lifecycle, provider execution, SCM,
  memory, planning, and final UI.

## Acceptance Criteria

- [x] The roadmap records the outcome-routing authority boundary.
- [x] The route vocabulary is explicit enough for a pure server read model.
- [x] The next card can implement read-only route computation without
  inventing command semantics.

## Result

Roadmap 013 now records the decision mapping, source map, blockers, read-model
shape, and no-effect rules for post-review outcome routing.
