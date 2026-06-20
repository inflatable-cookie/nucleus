# 361 Interruption Outcome Persistence

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../079-durable-wait-callback-interruption-recovery-persistence.md`

## Purpose

Persist interruption outcome evidence from durable executor paths.

## Scope

- Store interruption request/admission/outcome/receipt refs.
- Distinguish completed interruption, failed interruption, timeout, blocked,
  and cleanup-required states.
- Keep cancellation authority explicit and operator-gated.

## Acceptance Criteria

- [ ] Interruption outcomes survive reopen.
- [ ] Failed and timeout states remain inspectable.
- [ ] Task state is not silently rolled back.
- [ ] Raw provider material is not retained.

## Validation

- `cargo test -p nucleus-server interruption_outcome_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
