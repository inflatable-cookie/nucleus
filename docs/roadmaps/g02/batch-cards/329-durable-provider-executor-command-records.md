# 329 Durable Provider Executor Command Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../073-codex-provider-durable-executor-gate.md`

## Purpose

Define the durable command record used to request a server-owned Codex provider
executor attempt.

## Scope

- Add a focused command record for durable executor intent.
- Preserve source lane, lane admission id, provider instance, runtime session,
  write attempt, idempotency key, task/work refs, method, and evidence refs.
- Block command records that request raw material retention, client authority,
  task mutation, review acceptance, callback answering, interruption, recovery
  promotion, or SCM mutation.
- Keep the record execution-free.

## Acceptance Criteria

- [x] Valid executor command intent is accepted without provider execution.
- [x] Missing lane/admission/write-attempt identity is blocked.
- [x] Unsupported authority requests are blocked.
- [x] Raw material retention is blocked.

## Validation

- `cargo test -p nucleus-server durable_provider_executor_command -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
