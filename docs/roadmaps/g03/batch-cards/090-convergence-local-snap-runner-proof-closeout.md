# 090 Convergence Local Snap Runner Proof Closeout

Status: planned
Owner: Tom
Updated: 2026-06-21
Milestone: `../025-convergence-local-snap-runner-proof.md`

## Purpose

Validate local snap runner proof/evidence and select the next Convergence lane.

## Acceptance Criteria

- [ ] Validation passes or blockers are recorded.
- [ ] Gap index reflects local snap runner proof state.
- [ ] Next lane is selected from evidence.
- [ ] No Convergence backend effect is enabled.

## Validation

- `cargo test -p nucleus-server convergence_local_snap -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
