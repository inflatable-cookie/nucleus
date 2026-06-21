# 157 Durable Executor Dispatch Admission Type Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../048-durable-executor-dispatch-admission-split.md`

## Purpose

Move durable executor dispatch admission type/support code out of the front
door.

## Acceptance Criteria

- [x] Type/support code moves only where it reduces real front-door pressure.
- [x] Public type names and admission behavior remain unchanged.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI, or task behavior is added.

## Validation

- `cargo test -p nucleus-server durable_executor_dispatch_admission -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
