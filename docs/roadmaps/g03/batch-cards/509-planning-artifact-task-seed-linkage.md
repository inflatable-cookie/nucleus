# 509 Planning Artifact Task Seed Linkage

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../118-structured-planning-domain-foundation.md`

## Purpose

Define how app-native planning records link to existing planning artifact and
task seed records.

## Work

- [x] Map existing planning artifact/task seed ids to the new planning-domain
  refs.
- [x] Keep task seed promotion in the task-domain command path.
- [x] Represent memory and deep research links as refs only.
- [x] Document any compatibility gap that should be addressed before migration.

## Acceptance Criteria

- [x] Existing task seed inspection and promotion semantics are preserved.
- [x] Planning artifacts remain reviewable records.
- [x] No active task creation or memory/research execution is added.

## Evidence

- Added `PlanningArtifactLink` and `PlanningTaskSeedLink`.
- Added local review and task-seed promotion link states without depending on
  `nucleus-engine`.
- Added source refs for research run briefs, memory proposals, and evidence
  refs only.
- Added tests for artifact compatibility mapping, task-domain promotion
  authority, and memory/research refs as links only.
- `cargo test -p nucleus-planning` passed.
- `cargo check --workspace` passed.

## Compatibility Gap

Existing planning artifact and task seed payloads still live in the current
engine/server compatibility path. The new planning crate links to those records
by stable id and compatibility ref. A later migration can move payload ownership
after storage and query behavior prove the app-native planning boundary.
