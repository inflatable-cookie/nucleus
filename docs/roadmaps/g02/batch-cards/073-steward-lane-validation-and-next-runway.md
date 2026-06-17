# 073 Steward Lane Validation And Next Runway

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../018-steward-native-harness-and-effigy-tools.md`

## Purpose

Validate the steward/native harness record lane and compile the next runway.

## Scope

- Run focused native harness, engine, workspace, and docs validation.
- Reconcile contract wording with implemented record surfaces.
- Decide whether the next lane should implement command-backed Effigy
  inspection, steward proposals, or native runtime orchestration.
- Do not start live steward execution in this card.

## Acceptance Criteria

- [x] Current 018 cards are either completed or explicitly rehomed.
- [x] Contracts match implemented record surfaces.
- [x] The next ready card is broad enough for meaningful implementation work.

## Outcome

- Validated native harness and engine record surfaces for the steward lane.
- Closed the record-only steward/native harness tranche.
- Compiled the next g02 runway: native steward command boundary, Effigy
  command-backed inspection, management projection sync runtime, SCM working
  session runtime, and client diagnostics read models.
- Set the next ready card to `074-native-steward-command-records.md`.

## Validation

- [x] `cargo test -p nucleus-native-harness`
- [x] `cargo test -p nucleus-engine`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if live steward execution requires a new contract or operator direction.
