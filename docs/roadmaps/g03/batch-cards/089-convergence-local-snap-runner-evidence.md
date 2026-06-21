# 089 Convergence Local Snap Runner Evidence

Status: planned
Owner: Tom
Updated: 2026-06-21
Milestone: `../025-convergence-local-snap-runner-proof.md`

## Purpose

Add sanitized evidence records for stopped local snap runner proofs.

## Acceptance Criteria

- [ ] Ready proofs can produce reviewable evidence.
- [ ] Unready proofs remain blocked.
- [ ] Evidence contains only ids, counts, status, and sanitized refs.
- [ ] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_runner_evidence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
