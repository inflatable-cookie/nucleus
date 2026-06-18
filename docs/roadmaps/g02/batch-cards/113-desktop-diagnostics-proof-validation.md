# 113 Desktop Diagnostics Proof Validation

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../026-desktop-diagnostics-proof-surface.md`

## Purpose

Validate and close the disposable desktop diagnostics proof surface.

## Scope

- Run desktop checks and builds.
- Run Rust server checks.
- Advance to diagnostics source integration.

## Acceptance Criteria

- [x] Desktop diagnostics proof cards are complete or rehomed.
- [x] Diagnostics remain read-only.
- [x] Next ready card points to source integration.

## Outcome

Validated the desktop diagnostics proof surface and advanced the roadmap to
diagnostics source integration.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if final UI design is required.
