# 190 Provider Evidence Idempotency Recovery Rules

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../055-provider-auth-forge-execution-contract-lane.md`

## Purpose

Define sanitized provider response evidence, idempotency, retry, and recovery
rules for future forge execution.

## Acceptance Criteria

- [x] Provider response evidence is sanitized by default.
- [x] Raw provider payloads require separate artifact policy.
- [x] Mutating provider effects require idempotency keys.
- [x] Uncertain writes reconcile before retry.
- [x] Receipts and replay rules are explicit.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
