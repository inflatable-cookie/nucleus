# 114 Planning Management Projection Payloads

Status: active
Owner: Tom
Updated: 2026-06-24

## Purpose

Implement the first repo-backed management projection payloads for planning
artifacts and planning task seeds.

The promotion lane proved server-local planning seed storage, query, explicit
promotion, and diagnostics. The next gap is shared/project-committable planning
state, not UI or provider execution.

## Governing Refs

- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/planning-management-projection-shape.md`
- `docs/architecture/planning-task-seed-gap-matrix.md`
- `docs/roadmaps/g03/113-task-seed-promotion-command.md`

## Goals

- [x] Add concrete management projection payload vocabulary for planning
  artifacts and task seeds.
- [x] Add deterministic file refs for planning artifact and task seed
  projection files.
- [x] Add encode/decode validation without filesystem writes.
- [x] Add export planning from persisted Planning records.
- [ ] Keep import/admission, merge policy, SCM mutation, task promotion,
  provider execution, and UI out of scope.

## Execution Plan

- [x] Batch 1: add planning projection payload types and record-kind coverage.
- [x] Batch 2: add deterministic file refs and TOML codec tests.
- [x] Batch 3: add export plan composition from Planning domain records.
- [x] Batch 4: expose read-only diagnostics/CLI inspection if needed.
- [ ] Batch 5: validate and choose import/admission or planning-session depth
  as the next lane.

## Batch Cards

Ready cards:

- `batch-cards/482-planning-management-projection-next-lane-checkpoint.md`

Planned cards:

- No planned cards remain.

Completed cards:

- `batch-cards/481-planning-management-projection-validation.md`
- `batch-cards/480-planning-management-projection-query-diagnostics.md`
- `batch-cards/479-planning-management-projection-export-plan.md`
- `batch-cards/478-planning-management-projection-codec-tests.md`
- `batch-cards/477-planning-management-projection-file-refs.md`
- `batch-cards/476-planning-management-projection-record-kinds.md`
- `batch-cards/475-planning-management-projection-payload-selection.md`

## Acceptance Criteria

- [x] Planning artifact and task seed projection payloads are concrete.
- [x] Planning task seeds are not encoded as active tasks.
- [x] Projection encode/decode is deterministic and tested.
- [x] Export planning is read-only and does not write files or mutate SCM.
- [ ] Import/admission and merge policy remain explicit later work.

## Stop Conditions

- Projection import would become active planning authority without review.
- Task seed projection would create or mutate active tasks.
- File writes, SCM/forge mutation, provider execution, or UI behavior would be
  needed to complete the lane.
