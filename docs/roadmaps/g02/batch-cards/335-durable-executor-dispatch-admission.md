# 335 Durable Executor Dispatch Admission

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../074-codex-durable-executor-dispatch-gate.md`

## Purpose

Gate durable executor dispatch after selection and before any executor call.

## Scope

- Require accepted selection, explicit operator confirmation, runtime session
  evidence, provider readiness evidence, and matching write-attempt identity.
- Block client authority, automatic background execution, raw material
  retention, task mutation, review acceptance, callback answering,
  interruption, recovery promotion, and SCM mutation.
- Keep admission execution-free.

## Acceptance Criteria

- [x] Accepted selection can produce one deterministic dispatch admission.
- [x] Missing operator/runtime/provider evidence blocks admission.
- [x] Authority widening is blocked.
- [x] Admission does not invoke the executor.

## Validation

- `cargo test -p nucleus-server durable_executor_dispatch_admission -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
