# 364 Provider Idempotency Ledger

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../080-provider-runtime-hardening.md`

## Purpose

Record provider idempotency decisions for durable runtime effects.

## Scope

- Track command, dispatch, invocation, write attempt, outcome, and receipt ids.
- Detect duplicate effects across restart/reconnect.
- Return reconciliation records instead of duplicate writes.

## Acceptance Criteria

- [x] Duplicate write attempts are detected.
- [x] Replayed commands do not cause duplicate provider writes.
- [x] Ledger records survive reopen.
- [x] Client mutation authority remains false.

## Validation

- `cargo test -p nucleus-server provider_idempotency_ledger -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
