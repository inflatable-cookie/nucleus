# 131 Durable Executor Dispatch Selection Blocker Test Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../039-durable-executor-dispatch-selection-split.md`

## Purpose

Move dispatch selection blocker logic and tests into focused modules.

## Acceptance Criteria

- [x] Blocker behavior remains unchanged.
- [x] Tests are preserved in a focused module.
- [x] No provider write, process spawn, SCM mutation, remote transport, UI, or
  task behavior is added.

## Validation

- `cargo test -p nucleus-server durable_executor_dispatch_selection -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
