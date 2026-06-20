# 324 Provider Recovery Execution Policy Gate

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../072-codex-provider-recovery-execution-gate.md`

## Purpose

Define the policy record that decides whether an admitted Codex recovery
request may enter a provider execution path.

## Scope

- Add a focused recovery execution policy module.
- Require recovery need, admission, envelope, runtime, adapter, host,
  operator, recovery-target, provider-identity, resume-capability, and
  tool-capability evidence.
- Block task completion, review acceptance, interruption, callback answering,
  SCM mutation, replacement-thread promotion, raw provider material retention,
  and task mutation authority.
- Keep the policy record compile-only and execution-free.

## Acceptance Criteria

- [x] Accepted policy keeps `provider_write_executed=false`.
- [x] Missing evidence blocks execution admission.
- [x] Identity mismatches block execution admission.
- [x] Capability and tool overload blockers are represented.
- [x] Raw material, task mutation, and authority widening are blocked.

## Validation

- `cargo test -p nucleus-server recovery_execution_policy -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
