# 076 Selected Task Rework Work Item Composition

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../016-selected-task-rework-from-review-outcome.md`

## Purpose

Add the pure server model that composes rework preparation from admitted review
outcome evidence.

## Work

- [x] Add focused domain types in small modules.
- [x] Compose from selected-task route admission and review outcome records.
- [x] Preserve provenance to reviewed work-item refs, decision refs, and
  evidence refs.
- [x] Return refusal diagnostics for missing decision, missing evidence, stale
  route state, unsupported accepted-review routes, and planning ambiguity.

## Acceptance Criteria

- [x] Focused server tests cover admitted rejected/needs-changes paths.
- [x] Focused server tests cover refused accepted, stale, missing evidence, and
  planning ambiguity paths.
- [x] The model has no provider, SCM, planning, memory, task completion, or UI
  effects.

## Result

Added `selected_task_rework_preparation` as a small server module split into
`types`, `builder`, and focused tests.

The model accepts selected-task route admission plus operator/review/work/
evidence refs, admits rejected and needs-changes review outcomes, and refuses
mismatched route admission ids, mismatched review decision refs, missing work
refs, work refs not present on the route, evidence refs not present on the
route, and unsupported accepted-review routes.

The output remains a preparation preview. It does not create work items,
schedule agents, mutate task lifecycle state, run providers, touch SCM/forge,
write projections, apply memory/planning state, or create UI effects.

## Validation

- `cargo fmt`
- `cargo test -p nucleus-server selected_task_rework_preparation -- --nocapture`
