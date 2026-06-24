# 484 Planning Projection File Document Materialization

Status: completed
Owner: Tom
Updated: 2026-06-24
Milestone: `../115-planning-projection-file-export-capture.md`

## Purpose

Materialize planning projection export entries into deterministic TOML file
documents.

## Work

- [x] Convert planning export entries into file documents.
- [x] Encode documents with the existing TOML codec.
- [x] Restrict output refs to `nucleus/planning/` and
  `nucleus/planning/task-seeds/`.
- [x] Surface encode/path failures as controlled issues.

## Acceptance Criteria

- [x] Output is deterministic.
- [x] No files outside the projection root can be targeted.
- [x] No projection import, task promotion, SCM/forge mutation, provider
  execution, or UI behavior is added.
