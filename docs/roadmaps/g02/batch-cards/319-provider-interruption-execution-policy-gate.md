# 319 Provider Interruption Execution Policy Gate

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../071-codex-provider-interruption-execution-gate.md`

## Purpose

Define the policy gate for executing Codex provider interruption requests.

## Scope

- Add compile-only interruption execution policy records.
- Require interruption request, admission, envelope, runtime, adapter, host,
  operator, target, and capability evidence before execution admission.
- Block task completion, review acceptance, resume, callback answering, SCM
  mutation, raw provider material retention, and raw callback material
  retention.

## Acceptance Criteria

- [x] Accepted policy records do not execute provider writes.
- [x] Missing or mismatched identity blocks execution admission.
- [x] Forbidden authority widening is blocked.

## Validation

- targeted server tests
- `cargo check --workspace`
