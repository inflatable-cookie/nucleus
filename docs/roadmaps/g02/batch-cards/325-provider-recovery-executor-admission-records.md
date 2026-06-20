# 325 Provider Recovery Executor Admission Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../072-codex-provider-recovery-execution-gate.md`

## Purpose

Record recovery execution admission after policy acceptance and before any
provider resume write.

## Scope

- Preserve recovery need, envelope, provider thread, task, work item, provider
  instance, runtime session, write attempt, and idempotency identity.
- Reject non-accepted policy and mismatched identity.
- Keep executor invocation, raw provider material, replacement-thread
  promotion, task mutation, review acceptance, callback answering,
  interruption, and SCM mutation out of admission.

## Acceptance Criteria

- [x] Accepted policy can produce one deterministic admission record.
- [x] Blocked policy cannot produce admission.
- [x] Write-attempt and idempotency refs are explicit.
- [x] Admission remains sanitized and execution-free.

## Validation

- `cargo test -p nucleus-server recovery_executor_admission -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
