# 339 Durable Dispatch Invocation Preflight

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../075-codex-durable-dispatch-invocation-gate.md`

## Purpose

Define preflight records that decide whether an accepted durable dispatch
admission may proceed toward executor invocation.

## Scope

- Require accepted dispatch admission, explicit operator confirmation,
  provider readiness evidence, runtime session evidence, and matching
  write-attempt/idempotency identity.
- Block stale admissions, duplicate in-flight invocation attempts, unsupported
  provider methods, and missing evidence.
- Keep preflight execution-free.

## Acceptance Criteria

- [x] Accepted dispatch admission can pass preflight without invoking the
      executor.
- [x] Missing operator/provider/runtime evidence blocks preflight.
- [x] Duplicate in-flight invocation attempts are blocked.
- [x] Preflight does not execute provider writes or mutate tasks.

## Validation

- `cargo test -p nucleus-server durable_dispatch_invocation_preflight -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
