# 362 Recovery Outcome Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../079-durable-wait-callback-interruption-recovery-persistence.md`

## Purpose

Persist recovery outcome and repair-required evidence.

## Scope

- Store recovery need, admission, outcome, receipt, provider identity, and
  replacement-thread observation refs.
- Keep resume and replacement-thread promotion explicit.
- Preserve uncertain state as repair-required.

## Acceptance Criteria

- [x] Recovery outcomes survive reopen.
- [x] Replacement-thread observations are visible but not promoted.
- [x] Resume authority remains operator-gated.
- [x] Uncertain state becomes repair evidence, not success.

## Validation

- `cargo test -p nucleus-server recovery_outcome_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
