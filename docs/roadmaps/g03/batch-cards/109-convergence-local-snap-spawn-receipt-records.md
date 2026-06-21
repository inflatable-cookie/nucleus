# 109 Convergence Local Snap Spawn Receipt Records

Status: ready
Owner: Tom
Updated: 2026-06-21
Milestone: `../032-convergence-local-snap-spawn-receipt-boundary.md`

## Purpose

Build sanitized stopped spawn receipt records from ready local snap spawn
handoffs.

## Acceptance Criteria

- [ ] Ready handoffs produce stopped receipt records.
- [ ] Blocked, duplicate, and unsupported handoffs are not accepted.
- [ ] Receipt records preserve handoff, spawn request, preflight, replay,
  evidence, request, task, repo, authority, and idempotency refs.
- [ ] No process runner, raw output, or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_spawn_receipt -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
