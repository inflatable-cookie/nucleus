# 483 Planning Projection File Write Boundary Selection

Status: completed
Owner: Tom
Updated: 2026-06-24
Milestone: `../115-planning-projection-file-export-capture.md`

## Purpose

Select the first concrete file-write boundary for planning projection export.

## Work

- [x] Audit existing management projection file writer/runtime paths.
- [x] Identify where planning export entries should become file documents.
- [x] Define blocked paths for invalid refs, unsupported records, and missing
  authority.
- [x] Keep import/apply, SCM capture, and provider effects out of this card.

## Decision

Use the existing server-owned management projection file writer as the write
mechanism, but add a planning-only wrapper before file materialization.

Boundary:

- input is an already-built `ManagementProjectionExportPlan`
- accepted record kinds are only `PlanningArtifact` and `PlanningTaskSeed`
- accepted refs are only `nucleus/planning/<artifact-id>.toml` and
  `nucleus/planning/task-seeds/<seed-id>.toml`
- non-empty export issues block all writes before any file is created
- import/apply, SCM capture, provider execution, and task promotion stay out of
  this boundary

Planning artifact state loading is not selected here because there is not yet a
planning artifact storage codec. This lane writes from export-plan entries.

## Acceptance Criteria

- [x] The selected boundary is under server/engine authority already allowed by
  contracts.
- [x] The next implementation card has bounded file materialization work.
- [x] No commits, pushes, publication, projection import, or task promotion are
  required.
