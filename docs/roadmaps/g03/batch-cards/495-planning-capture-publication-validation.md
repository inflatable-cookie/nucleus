# 495 Planning Capture Publication Validation

Status: completed
Owner: Tom
Updated: 2026-07-02
Milestone: `../116-planning-projection-capture-publication-gate.md`

## Purpose

Validate the publication/share gate and keep the Northstar lane coherent.

## Work

- [x] Run focused engine/server tests for admission, stopped requests, and
  diagnostics.
- [x] Run focused CLI/Effigy checks if a CLI route exists.
- [x] Run docs QA, Northstar QA, diff check, and doctor.
- [x] Confirm `## Next Task` appears only in `docs/roadmaps/README.md`.

## Acceptance Criteria

- [x] Focused tests pass.
- [x] Doctor has zero errors.
- [x] Roadmap and batch-card state remains coherent.

## Evidence

- `cargo fmt --check`
- `cargo test -p nucleus-server planning_capture_publication`
- `cargo test -p nucleusd planning_capture_publication`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `effigy server:query:planning-capture-publication-diagnostics`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `rg "^## Next Task" README.md AGENTS.md docs -n`
- `effigy doctor`
