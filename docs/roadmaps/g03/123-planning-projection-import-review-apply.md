# 123 Planning Projection Import Review Apply

Status: completed
Owner: Tom
Updated: 2026-07-03

## Purpose

Add the first controlled review/apply lane for planning projection imports.

Roadmap `117` already reads projected planning files into stopped candidates,
admissions, conflict staging, and diagnostics. Roadmaps `118` through `122`
then added app-native planning, memory proposal, research run brief, disposable
inspection, and memory proposal review foundations. This lane can now decide
how reviewed import records become apply plans without silently mutating active
planning state.

The first pass is review/apply preparation. It does not auto-merge conflicts,
create active tasks, promote task seeds, write repository projections, mutate
SCM/forge state, run providers, schedule agents, or add final UI behavior.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/planning-management-projection-shape.md`
- `docs/architecture/planning-task-seed-gap-matrix.md`
- `docs/roadmaps/g03/117-planning-projection-import-admission.md`
- `docs/roadmaps/g03/118-structured-planning-domain-foundation.md`
- `docs/roadmaps/g03/122-memory-proposal-review-command-foundation.md`

## Goals

- [x] Select the first review/apply authority boundary for planning projection
  import records.
- [x] Define which reviewed import records can become apply plans.
- [x] Keep semantic conflicts as explicit blockers unless a human review
  record resolves them.
- [x] Add dry-run apply planning before any active planning mutation.
- [x] Persist stopped apply records with no-effect flags.
- [x] Expose diagnostics, `nucleusd`, and Effigy inspection before desktop
  controls.
- [x] Keep task promotion, active task creation, SCM/forge mutation, provider
  execution, agent scheduling, semantic merge automation, accepted memory
  mutation, and final UI out of scope.

## Execution Plan

- [x] Batch 1: select review/apply boundary, target records, blocked effects,
  and stop conditions.
- [x] Batch 2: model apply-readiness over reviewed import admissions and
  conflict staging records.
- [x] Batch 3: add dry-run apply plan records without mutating active planning
  records.
- [x] Batch 4: persist stopped apply records with revision expectations and
  no-effect flags.
- [x] Batch 5: expose diagnostics query/control/CLI/Effigy.
- [x] Batch 6: validate and choose whether to admit active planning mutation,
  desktop controls, accepted memory authority, or research execution planning.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/542-planning-import-apply-validation-next-lane.md`
- `batch-cards/541-planning-import-apply-diagnostics-query-cli-effigy.md`
- `batch-cards/540-planning-import-apply-stopped-persistence.md`
- `batch-cards/539-planning-import-apply-dry-run-plan.md`
- `batch-cards/538-planning-import-apply-readiness-model.md`
- `batch-cards/537-planning-import-review-apply-boundary.md`

## Acceptance Criteria

- [x] Review/apply records are separate from import scan candidates and stopped
  admissions.
- [x] Conflicts, missing refs, unsupported schemas, unsafe refs, and stale
  revisions block apply planning.
- [x] Dry-run apply plans are inspectable without mutating active planning
  records.
- [x] Stopped apply persistence records retain sanitized evidence refs and
  no-effect flags.
- [x] Diagnostics expose counts without raw payloads or private planning
  bodies.
- [x] No active planning mutation, task creation, task promotion, provider
  execution, agent scheduling, SCM/forge mutation, semantic merge automation,
  accepted memory mutation, or UI behavior is added.

## Stop Conditions

- The work requires automatic semantic merge resolution.
- The work requires creating active tasks from imported task seeds.
- The work requires mutating active planning records before an explicit apply
  admission and validation lane.
- The work requires SCM, forge, provider, callback, interruption, or recovery
  effects.
- The work requires raw payload retention or final UI behavior.
