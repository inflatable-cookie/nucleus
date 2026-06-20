# 2026-06-20 Stocktake

Status: accepted
Owner: Tom
Updated: 2026-06-20

## Purpose

Record the end-of-day checkpoint after the SCM capture, review, and
change-request preparation tranche.

## Built

- SCM capture workflow composition and read-only control diagnostics.
- Operator review readiness over replayed SCM capture evidence.
- Explicit SCM capture review decisions with persisted accepted, rejected,
  needs-changes, and abandoned outcomes.
- Adapter-neutral change-request preparation admission and control diagnostics.
- A planned adapter-specific change-request plan lane.

## Validation State

The last full implementation validation before this stocktake was green:

- `cargo check --workspace --quiet`
- `cargo test --workspace --quiet`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

`effigy doctor` is red on `scan.god-files`. The current report has 150
findings: 113 warnings and 37 errors. The largest pressure is now in
request-handler diagnostics tests, request-handler query routing,
control-envelope diagnostics tests, and new SCM review/preparation modules.

## Assessment

The product direction is still sound. The chain from task completion evidence
to explicit review, explicit decision, and adapter-neutral change-request
preparation matches the server-owned authority model and avoids hidden SCM,
forge, provider, callback, interruption, recovery, or raw-output authority.

The risk is structural accretion, not a wrong architecture. Request-handler,
control DTO, and SCM persistence/test surfaces are collecting too much code in
too few files. Continuing directly into adapter-specific SCM plans would make
the red doctor state worse and blur module ownership.

## Decision

Pause roadmap 123 before implementation. Add roadmap 124 as a bounded
health/runway rebaseline. Resume adapter-specific change-request plan selection
only after the largest god-file pressure points are split or explicitly
accepted as follow-on debt.

The generation remains in `g02`; this is a health checkpoint inside the same
orchestration/engine-core generation, not a new generation boundary.
