# 114 Convergence Local Snap Spawn Receipt Control Closeout

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../033-convergence-local-snap-spawn-receipt-control.md`

## Purpose

Validate local snap spawn receipt control and select the Convergence exit
lane.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Gap index reflects local snap spawn receipt control state.
- [x] Next lane is the Convergence exit lane, not another Convergence feature
  lane.
- [x] No Convergence backend effect is enabled.

## Validation

- `cargo test -p nucleus-server convergence_local_snap -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
