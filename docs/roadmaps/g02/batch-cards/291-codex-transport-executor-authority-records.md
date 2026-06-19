# 291 Codex Transport Executor Authority Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../065-codex-turn-start-transport-executor-handoff.md`

## Purpose

Define the authority records that decide whether Codex `turn/start` transport
execution may be considered.

## Scope

- Record execution host authority.
- Record provider instance authority.
- Record operator confirmation state.
- Record task-mutation denial.
- Record raw payload and stream-retention policy.

## Acceptance Criteria

- [x] Transport execution is blocked by default.
- [x] Missing operator confirmation is explicit.
- [x] Missing or stale provider/host authority is explicit.
- [x] Task mutation remains blocked.

## Validation

- targeted Codex/server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if authority rules need a new contract before records can be modeled.
