# 148 Turn Start Executor Smoke Boundary Type Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../045-turn-start-executor-smoke-boundary-split.md`

## Purpose

Move turn-start executor smoke boundary type/support code out of the front
door.

## Acceptance Criteria

- [x] Type/support code moves only where it reduces real front-door pressure.
- [x] Public type names and smoke boundary behavior remain unchanged.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI, or task behavior is added.

## Validation

- `cargo test -p nucleus-server turn_start_executor_smoke_boundary -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
