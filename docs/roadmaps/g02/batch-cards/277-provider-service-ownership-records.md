# 277 Provider Service Ownership Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../062-provider-runtime-materialisation-gate.md`

## Purpose

Add provider-service ownership records shaped by the T3 Code provider service
lesson.

## Scope

- Name service-owned provider command routing records.
- Name session runtime stream ownership records.
- Name reactor readiness and blocked states.
- Do not start providers or route live commands.

## Acceptance Criteria

- Provider service ownership is represented separately from provider instance
  config.
- Runtime stream ownership is explicit.
- Records do not imply false uniformity across providers.

## Validation

- [x] targeted server/protocol tests
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if ownership rules require a contract update before coding.

## Result

Added server-side provider service ownership records for service identity,
command lane ownership, runtime stream ownership, and reactor readiness.

The records separate provider service ownership from client command authority
and task mutation authority. Tests cover ready and blocked service states
without starting providers or sending commands.
