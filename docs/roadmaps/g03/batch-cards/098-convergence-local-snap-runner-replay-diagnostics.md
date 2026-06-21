# 098 Convergence Local Snap Runner Replay Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../028-convergence-local-snap-runner-replay-boundary.md`

## Purpose

Expose read-only diagnostics for persisted local snap runner replay records.

## Acceptance Criteria

- [x] Diagnostics count replayed, blocked, duplicate, and skipped decisions.
- [x] Diagnostics expose no raw command output.
- [x] Diagnostics carry no mutation or backend authority.
- [x] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_runner_replay_diagnostics -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
