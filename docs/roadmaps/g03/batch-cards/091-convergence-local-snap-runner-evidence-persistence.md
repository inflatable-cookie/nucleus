# 091 Convergence Local Snap Runner Evidence Persistence

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../026-convergence-local-snap-runner-evidence-persistence.md`

## Purpose

Persist sanitized Convergence local snap runner evidence with duplicate-safe
evidence ids.

## Acceptance Criteria

- [x] Reviewable evidence can persist.
- [x] Duplicate evidence ids become no-op records.
- [x] Blocked evidence remains inspectable.
- [x] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_runner_evidence_persistence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
