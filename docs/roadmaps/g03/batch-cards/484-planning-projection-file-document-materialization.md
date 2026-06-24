# 484 Planning Projection File Document Materialization

Status: planned
Owner: Tom
Updated: 2026-06-24
Milestone: `../115-planning-projection-file-export-capture.md`

## Purpose

Materialize planning projection export entries into deterministic TOML file
documents.

## Work

- [ ] Convert planning export entries into file documents.
- [ ] Encode documents with the existing TOML codec.
- [ ] Restrict output refs to `nucleus/planning/` and
  `nucleus/planning/task-seeds/`.
- [ ] Surface encode/path failures as controlled issues.

## Acceptance Criteria

- [ ] Output is deterministic.
- [ ] No files outside the projection root can be targeted.
- [ ] No projection import, task promotion, SCM/forge mutation, provider
  execution, or UI behavior is added.
