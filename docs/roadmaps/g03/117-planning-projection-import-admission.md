# 117 Planning Projection Import Admission

Status: active
Owner: Tom
Updated: 2026-07-02

## Purpose

Add the first import/admission lane for repo-backed planning projection files.

Roadmaps `114` through `116` can encode planning projection payloads,
materialize reviewed files under `nucleus/planning/`, prepare capture evidence,
and admit stopped publication/share requests. This lane reads projected
planning files back into controlled server records and stages import readiness
without applying those files as active planning authority.

This lane does not create active tasks, promote task seeds, resolve semantic
merge conflicts, mutate SCM/forge state, run providers, schedule agents, or
add UI behavior.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/planning-management-projection-shape.md`
- `docs/architecture/planning-task-seed-gap-matrix.md`
- `docs/roadmaps/g03/116-planning-projection-capture-publication-gate.md`

## Goals

- [x] Select the import/admission authority boundary for planning projection
  files.
- [x] Represent scanned projected planning files as controlled read-only import
  candidates.
- [x] Admit reviewed import candidates into stopped import records without
  applying them to active planning state.
- [x] Stage semantic conflicts as review records instead of auto-merging them.
- [x] Expose sanitized diagnostics and optional query/CLI inspection.
- [x] Keep task promotion, active planning mutation, SCM/forge mutation,
  provider execution, agent scheduling, semantic merge resolution, and UI out
  of scope.

## Execution Plan

- [x] Batch 1: select import/admission vocabulary, authority, and blocked
  effects.
- [x] Batch 2: model read-only projected-file scan candidates and parse/blocker
  outcomes.
- [x] Batch 3: model stopped import admission records from reviewed candidates.
- [x] Batch 4: stage semantic conflict review records without resolving them.
- [x] Batch 5: expose diagnostics and read-only inspection if the server
  surface is ready.
- [ ] Batch 6: validate and choose planning-session depth, task-readiness
  linkage, or import apply/review as the next lane.

## Batch Cards

Ready cards:

- `batch-cards/504-planning-projection-import-next-lane-checkpoint.md`

Planned cards:

None.

Completed cards:

- `batch-cards/503-planning-projection-import-validation.md`
- `batch-cards/502-planning-projection-import-cli-effigy.md`
- `batch-cards/501-planning-projection-import-diagnostics.md`
- `batch-cards/500-planning-projection-import-conflict-staging.md`
- `batch-cards/499-planning-projection-import-admission-records.md`
- `batch-cards/498-planning-projection-import-scan-candidates.md`
- `batch-cards/497-planning-projection-import-boundary-selection.md`

## Acceptance Criteria

- [x] Import candidates can cite deterministic planning projection file refs.
- [x] Unsupported schemas, unsafe refs, parse failures, duplicate ids, and
  semantic conflicts become controlled records.
- [x] Stopped import records carry sanitized evidence refs and no-effect flags.
- [x] Diagnostics expose counts without raw payload retention.
- [x] No active planning mutation, task creation, task promotion, agent
  scheduling, SCM/forge mutation, provider execution, semantic merge
  resolution, or UI behavior is added.

## Stop Conditions

- The work requires applying projected files as active planning authority.
- The work requires resolving semantic merge conflicts automatically.
- The work requires creating active tasks from task seed projections.
- The work requires SCM, forge, provider, callback, interruption, or recovery
  effects.
- The work requires raw payload retention or UI behavior.
