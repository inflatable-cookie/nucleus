# 103 Convergence Local Snap Spawn Request Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../030-convergence-local-snap-spawn-request-boundary.md`

## Purpose

Build stopped process-spawn request records from ready local snap execution
preflight records.

## Acceptance Criteria

- [x] Ready preflight records produce stopped spawn-request records.
- [x] Blocked, duplicate, and unsupported preflight records are not ready.
- [x] Spawn-request records preserve preflight, replay, evidence, request,
  task, repo, authority, and idempotency refs.
- [x] No process or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_spawn_request -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
