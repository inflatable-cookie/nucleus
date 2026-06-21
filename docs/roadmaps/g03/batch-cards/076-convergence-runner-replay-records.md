# 076 Convergence Runner Replay Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../021-convergence-runner-replay-boundary.md`

## Purpose

Persist replay-safe records for stopped Convergence runner adapter decisions.

## Acceptance Criteria

- [x] Replay records derive from stopped adapter records.
- [x] Stable replay ids and duplicate no-op handling are defined.
- [x] Convergence provider refs stay sanitized and optional.
- [x] No backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_runner_replay_records -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
