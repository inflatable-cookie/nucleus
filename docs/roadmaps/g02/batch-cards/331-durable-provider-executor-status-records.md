# 331 Durable Provider Executor Status Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../073-codex-provider-durable-executor-gate.md`

## Purpose

Add status/readback records for durable provider executor commands.

## Scope

- Represent queued, running, completed, failed, blocked, timed-out, and
  cleanup-required states.
- Link command status to live executor outcome ids and runtime receipt ids
  where available.
- Keep status records authority-free.

## Acceptance Criteria

- [x] Command status is inspectable without provider authority.
- [x] Terminal states link to sanitized receipts/outcomes.
- [x] Blocked and cleanup-required states preserve evidence refs.
- [x] Status records do not mutate tasks or provider state.

## Validation

- `cargo test -p nucleus-server durable_provider_executor_status -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
