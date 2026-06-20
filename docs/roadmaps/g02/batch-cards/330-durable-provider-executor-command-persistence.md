# 330 Durable Provider Executor Command Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../073-codex-provider-durable-executor-gate.md`

## Purpose

Persist accepted durable provider executor command records through local state.

## Scope

- Add sanitized local-store persistence for accepted command records.
- Reject duplicate command ids and duplicate write-attempt ids
  deterministically.
- Read command records back for replay and diagnostics.
- Keep raw provider material out of persisted state.

## Acceptance Criteria

- [x] Accepted command records survive reopen.
- [x] Duplicate command/write-attempt ids are rejected.
- [x] Persistence keeps sanitized refs only.
- [x] Replay order is deterministic.

## Validation

- `cargo test -p nucleus-server durable_provider_executor_command_persistence -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
