# 077 Convergence Runner Replay Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../021-convergence-runner-replay-boundary.md`

## Purpose

Expose read-only diagnostics for persisted Convergence runner replay records.

## Acceptance Criteria

- [x] Diagnostics count replayed, duplicate, blocked, and unsupported records.
- [x] Diagnostics expose effect-family counts without raw provider payloads.
- [x] Diagnostics carry no mutation or backend authority.
- [x] No backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_runner_replay_diagnostics -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
