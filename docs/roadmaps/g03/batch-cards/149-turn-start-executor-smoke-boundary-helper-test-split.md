# 149 Turn Start Executor Smoke Boundary Helper Test Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../045-turn-start-executor-smoke-boundary-split.md`

## Purpose

Move turn-start executor smoke boundary helper/test code into focused modules
if needed after the type/support split.

## Acceptance Criteria

- [x] Helper/test code is split only where it reduces real pressure.
- [x] Smoke boundary behavior remains unchanged.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI, or task behavior is added.

## Validation

- `cargo test -p nucleus-server turn_start_executor_smoke_boundary -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
