# 336 Durable Executor Dispatch Outcome Linkage

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../074-codex-durable-executor-dispatch-gate.md`

## Purpose

Link admitted durable executor dispatch attempts to sanitized live executor
outcomes and durable executor status records.

## Scope

- Reuse persisted live executor outcome records as the provider outcome source.
- Build durable status records for accepted, running, completed, failed,
  timed-out, blocked, and cleanup-required states.
- Keep task/review/callback/interruption/recovery/SCM authority out of linkage.

## Acceptance Criteria

- [x] Dispatch outcomes update durable status records by reference.
- [x] Completed outcomes link receipt and live executor outcome refs.
- [x] Failure and cleanup states remain inspectable.
- [x] Linkage records do not mutate tasks or provider state.

## Validation

- `cargo test -p nucleus-server durable_executor_dispatch_outcome_linkage -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
