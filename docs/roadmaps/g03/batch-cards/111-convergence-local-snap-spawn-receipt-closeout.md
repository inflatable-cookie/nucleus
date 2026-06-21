# 111 Convergence Local Snap Spawn Receipt Closeout

Status: planned
Owner: Tom
Updated: 2026-06-21
Milestone: `../032-convergence-local-snap-spawn-receipt-boundary.md`

## Purpose

Validate stopped local snap spawn receipt records and select the next
Convergence lane.

## Acceptance Criteria

- [ ] Validation passes or blockers are recorded.
- [ ] Gap index reflects stopped local snap spawn receipt state.
- [ ] Next lane is selected from evidence.
- [ ] No Convergence backend effect is enabled.

## Validation

- `cargo test -p nucleus-server convergence_local_snap -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
