# 341 Durable Dispatch Executor Handoff

Status: ready
Owner: Tom
Updated: 2026-06-20
Milestone: `../075-codex-durable-dispatch-invocation-gate.md`

## Purpose

Bridge accepted durable invocation requests to the existing Codex live executor
boundary.

## Scope

- Reuse the sanitized Codex live executor request/outcome path where possible.
- Preserve method allowlist and lane identity.
- Keep handoff explicit and operator-gated.
- Do not add unattended background execution.

## Acceptance Criteria

- [ ] Accepted invocation request can be translated into a live executor
      handoff record.
- [ ] Unsupported methods are blocked before executor handoff.
- [ ] Handoff records preserve write-attempt and idempotency identity.
- [ ] Handoff does not retain raw provider material.

## Validation

- `cargo test -p nucleus-server durable_dispatch_executor_handoff -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
