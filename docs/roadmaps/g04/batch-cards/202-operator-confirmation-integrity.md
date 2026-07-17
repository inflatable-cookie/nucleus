# 202 Operator Confirmation Integrity

Status: completed
Owner: Claude
Updated: 2026-07-17
Milestone: `../042-execution-safety-honesty-and-enforcement.md`
Auto-start next card: no

## Objective

Stop `--confirm-real-write` fabricating `OperatorConfirmation::Confirmed`
evidence from a bare CLI flag.

## Steps

- model flag-based confirmation as its own variant (e.g.
  `CliFlagAsserted`) distinct from interactively confirmed
- ensure write gates that require operator confirmation treat flag-asserted
  confirmation per policy, not as interactive evidence
- audit remaining hardcoded evidence-ref strings in smoke paths and label
  fixture-fed runs distinctly from live runs in output

## Acceptance

- [x] no code path mints `Confirmed` evidence without a confirmation source
- [x] fixture-backed smoke output visually distinct from live output
- [x] gate tests updated for the new variant

## Validation

- `cargo test -p nucleus-server`
- `cargo test -p nucleusd`

## Stop Conditions

- stop before building interactive confirmation UI; that belongs to a
  desktop lane
