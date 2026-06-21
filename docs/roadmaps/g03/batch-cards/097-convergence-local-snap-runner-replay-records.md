# 097 Convergence Local Snap Runner Replay Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../028-convergence-local-snap-runner-replay-boundary.md`

## Purpose

Persist replayable stopped local snap command decisions without running
`converge snap`.

## Acceptance Criteria

- [x] Runnable stopped adapter records produce replay records.
- [x] Blocked, duplicate, and unsupported adapter records are skipped with
  visible blockers.
- [x] Replay records preserve evidence, request, admission, task, repo,
  authority, and idempotency refs.
- [x] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_runner_replay -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
