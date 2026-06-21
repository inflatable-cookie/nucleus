# 089 Convergence Local Snap Runner Evidence

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../025-convergence-local-snap-runner-proof.md`

## Purpose

Add sanitized evidence records for stopped local snap runner proofs.

## Acceptance Criteria

- [x] Ready proofs can produce reviewable evidence.
- [x] Unready proofs remain blocked.
- [x] Evidence contains only ids, counts, status, and sanitized refs.
- [x] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_runner_evidence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
