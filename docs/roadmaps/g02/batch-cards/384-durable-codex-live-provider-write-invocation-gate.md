# 384 Durable Codex Live Provider Write Invocation Gate

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../084-durable-codex-live-provider-write-invocation.md`

## Purpose

Define the final gate before a durable Codex live provider-write smoke can be
invoked.

## Scope

- Accept only an eligible durable live-smoke boundary.
- Require explicit operator confirmation and effect flag evidence.
- Reject dry-run and confirmation-only modes.
- Keep invocation, provider-write, task, review, callback, cancellation,
  resume, and SCM authority separated in the record.

## Acceptance Criteria

- [x] Eligible boundary can produce an invocation-ready record.
- [x] Dry-run and confirmation-only boundary records block invocation.
- [x] Unsafe boundary authority blocks invocation.
- [x] The gate itself still performs no provider I/O.

## Result

Added `provider_durable_codex_live_write_invocation_gate` with explicit
readiness, blocker, evidence, confirmation, and no-authority fields.

## Validation

- `cargo test -p nucleus-server durable_codex_live_provider_write_invocation_gate -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
