# 488 Planning Projection File Export Validation

Status: completed
Owner: Tom
Updated: 2026-06-24
Milestone: `../115-planning-projection-file-export-capture.md`

## Purpose

Validate planning projection file export and capture-prep readiness.

## Work

- [x] Run focused management projection tests.
- [x] Run focused server/CLI tests if a server or CLI path exists.
- [x] Run docs QA, Northstar QA, diff check, and doctor.

## Acceptance Criteria

- [x] Focused tests pass.
- [x] Doctor has zero errors.
- [x] Roadmap state remains coherent.

## Evidence

- `cargo test -p nucleus-engine management_sync::tests::capture`
- `cargo test -p nucleus-server management_projection_state`
- `cargo test -p nucleus-server planning_projection_file_write`
- `cargo test -p nucleusd planning_projection_file_write`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `effigy server:query:planning-projection-file-write-diagnostics`
- `effigy qa:docs`
- `effigy qa:northstar`
- `effigy doctor`
- `git diff --check`
- `rg "^## Next Task" README.md AGENTS.md docs -n`
