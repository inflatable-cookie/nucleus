# 106 Convergence Local Snap Spawn Handoff Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../031-convergence-local-snap-spawn-handoff-boundary.md`

## Purpose

Build stopped spawn handoff records from ready local snap spawn requests.

## Acceptance Criteria

- [x] Ready spawn requests produce stopped handoff records.
- [x] Blocked, duplicate, and unsupported spawn requests are not ready.
- [x] Handoff records preserve spawn request, preflight, replay, evidence,
  request, task, repo, authority, and idempotency refs.
- [x] No process runner or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_spawn_handoff -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
