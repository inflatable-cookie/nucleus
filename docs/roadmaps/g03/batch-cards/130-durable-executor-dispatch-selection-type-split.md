# 130 Durable Executor Dispatch Selection Type Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../039-durable-executor-dispatch-selection-split.md`

## Purpose

Move durable executor dispatch selection type definitions out of the front
door.

## Acceptance Criteria

- [x] Public type names remain unchanged.
- [x] Dispatch-selection behavior remains unchanged.
- [x] No provider write, process spawn, SCM mutation, remote transport, UI, or
  task behavior is added.

## Validation

- `cargo test -p nucleus-server durable_executor_dispatch_selection -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
