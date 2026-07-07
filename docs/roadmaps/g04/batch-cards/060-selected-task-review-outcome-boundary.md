# 060 Selected Task Review Outcome Boundary

Status: ready
Owner: Tom
Updated: 2026-07-07
Milestone: `../013-selected-task-review-outcome-routing.md`

## Purpose

Define the boundary for routing review decisions into the next admissible
server-owned action.

## Work

- [ ] Map accepted, rejected, needs-changes, and abandoned review decisions to
  route candidates.
- [ ] Define source refs for decision records, selected-task review state, task
  lifecycle state, evidence refs, receipts, and SCM handoff context.
- [ ] Define blockers for missing decision records, stale task state, missing
  evidence, unsupported lifecycle state, and ambiguous operator intent.
- [ ] Document no-effect rules for task lifecycle, provider execution, SCM,
  memory, planning, and final UI.

## Acceptance Criteria

- [ ] The roadmap records the outcome-routing authority boundary.
- [ ] The route vocabulary is explicit enough for a pure server read model.
- [ ] The next card can implement read-only route computation without
  inventing command semantics.
