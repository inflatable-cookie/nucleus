# 334 Durable Executor Dispatch Selection Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../074-codex-durable-executor-dispatch-gate.md`

## Purpose

Define records that select persisted durable executor commands for possible
dispatch.

## Scope

- Represent command readiness, current status, lane, provider instance,
  runtime session, write attempt, idempotency, and evidence refs.
- Block selection for non-accepted commands, terminal statuses, missing
  operator confirmation, missing runtime session, duplicate in-flight writes,
  or stale command evidence.
- Keep selection read-only and execution-free.

## Acceptance Criteria

- [x] Eligible queued commands can be selected without provider execution.
- [x] Terminal or blocked command statuses are not selected.
- [x] Missing confirmation/evidence blocks selection.
- [x] Selection records do not mutate provider or task state.

## Validation

- `cargo test -p nucleus-server durable_executor_dispatch_selection -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
