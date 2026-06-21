# 080 Convergence Local Snap Admission Diagnostics

Status: planned
Owner: Tom
Updated: 2026-06-21
Milestone: `../022-convergence-local-snap-admission.md`

## Purpose

Expose read-only diagnostics for Convergence local snap admission records.

## Acceptance Criteria

- [ ] Diagnostics count admitted, blocked, duplicate, and unsupported records.
- [ ] Diagnostics distinguish local snap authority from remote effects.
- [ ] Diagnostics carry no mutation or backend authority.
- [ ] No backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_admission_diagnostics -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
