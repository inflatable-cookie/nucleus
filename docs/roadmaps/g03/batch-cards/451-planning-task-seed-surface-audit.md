# 451 Planning Task Seed Surface Audit

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../111-planning-artifact-task-seed-promotion.md`

## Purpose

Audit current planning artifact, task seed, task command, and projection code
before implementing planning-to-task seed behavior.

## Governing Refs

- `docs/contracts/005-task-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/015-deep-research-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/task-project-workflow-gap-matrix.md`

## Work

- [x] Inspect `crates/nucleus-server/src/task_seed.rs`.
- [x] Inspect task command create/update/delegate behavior.
- [x] Inspect task projection and management projection records.
- [x] Search for existing planning artifact or task seed structures.
- [x] Identify whether first implementation should live in `nucleus-engine`,
  `nucleus-tasks`, a new planning crate/module, or `nucleus-server`.

## Acceptance Criteria

- [x] Audit names concrete files and missing surfaces.
- [x] Audit separates record modeling from promotion commands.
- [x] Next card can produce a gap matrix without new research.

## Result

Audit recorded in
`docs/architecture/planning-task-seed-gap-matrix.md`.

Key finding:

- `crates/nucleus-server/src/task_seed.rs` writes concrete bootstrap task
  records and is not the structured planning task seed model.
- persistence vocabulary already has Planning, PlanningArtifact, and TaskSeed
  shapes, but no domain record model or query path exists.

## Stop Conditions

- No promoted contract supports task seed records.
- Existing code has hidden task seed behavior that conflicts with the planning
  contract.
