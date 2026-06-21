# 088 Convergence Local Snap Runner Proof Records

Status: ready
Owner: Tom
Updated: 2026-06-21
Milestone: `../025-convergence-local-snap-runner-proof.md`

## Purpose

Create stopped local snap runner proof records from persisted local snap
requests.

## Acceptance Criteria

- [ ] Persisted requests produce ready proof records.
- [ ] Duplicate and blocked persistence are blocked.
- [ ] Proof records preserve request and authority refs.
- [ ] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_runner_proof -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
