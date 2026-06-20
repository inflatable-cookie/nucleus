# 320 Provider Interruption Executor Admission Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../071-codex-provider-interruption-execution-gate.md`

## Purpose

Record interruption-to-executor admission after policy acceptance.

## Scope

- Add reference-only admission records for provider interruption execution.
- Preserve interruption request, envelope, target, provider instance, runtime
  session, write attempt, and idempotency identity.
- Keep executor invocation separate from admission.

## Acceptance Criteria

- [x] Accepted records preserve interruption execution identity.
- [x] Admission does not execute provider writes.
- [x] Raw provider material, task mutation, review acceptance, resume, and SCM
      authority remain blocked.

## Validation

- targeted server tests
- `cargo check --workspace`
