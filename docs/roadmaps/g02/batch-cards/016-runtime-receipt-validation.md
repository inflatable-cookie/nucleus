# 016 Runtime Receipt Validation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Validate and close the runtime receipts and effect reactors milestone.

## Scope

- Focused runtime receipt tests.
- Existing read-only command evidence tests.
- Workspace compile.
- Northstar docs checks.
- Milestone closeout and next pointer.

## Out Of Scope

- Full test suite unless focused checks expose broad risk.
- Provider harness tests.
- SCM/checkpoint implementation.

## Promotion Targets

- `docs/roadmaps/g02/005-runtime-receipts-and-effect-reactors.md`
- `docs/roadmaps/README.md`

## Acceptance Criteria

- [x] `cargo check --workspace` passes.
- [x] Focused runtime receipt/server tests pass.
- [x] `effigy qa:docs` passes.
- [x] `effigy qa:northstar` passes.
- [x] The next lane remains `g02/006-checkpoint-and-diff-foundation.md` unless
  validation exposes a contract gap.

## Stop Conditions

- Runtime receipts reveal missing side-effect safety rules in
  `020-runtime-receipt-contract.md`.

## Outcome

Validated runtime receipts with focused engine/server tests, read-only command
evidence coverage, workspace compile, and Northstar docs checks.
