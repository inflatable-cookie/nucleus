# 108 Diagnostics DTO Validation

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../025-diagnostics-control-dto-serialization.md`

## Purpose

Validate and close diagnostics DTO serialization.

## Scope

- Run server serialization and docs gates.
- Confirm DTOs preserve authority boundaries.
- Advance to desktop proof surface.

## Acceptance Criteria

- [x] Diagnostics DTO serialization cards are complete or rehomed.
- [x] Control envelopes can carry diagnostics responses.
- [x] Next ready card points to desktop diagnostics proof.

## Outcome

Validated diagnostics DTO serialization and advanced the runway to desktop
diagnostics proof work.

## Validation

- `cargo test -p nucleus-server`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if serialization needs UI design decisions.
