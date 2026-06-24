# 483 Planning Projection File Write Boundary Selection

Status: ready
Owner: Tom
Updated: 2026-06-24
Milestone: `../115-planning-projection-file-export-capture.md`

## Purpose

Select the first concrete file-write boundary for planning projection export.

## Work

- [ ] Audit existing management projection file writer/runtime paths.
- [ ] Identify where planning export entries should become file documents.
- [ ] Define blocked paths for invalid refs, unsupported records, and missing
  authority.
- [ ] Keep import/apply, SCM capture, and provider effects out of this card.

## Acceptance Criteria

- [ ] The selected boundary is under server/engine authority already allowed by
  contracts.
- [ ] The next implementation card has bounded file materialization work.
- [ ] No commits, pushes, publication, projection import, or task promotion are
  required.
