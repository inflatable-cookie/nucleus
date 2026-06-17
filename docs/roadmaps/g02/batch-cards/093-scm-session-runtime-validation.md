# 093 SCM Session Runtime Validation

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../022-scm-working-session-runtime.md`

## Purpose

Validate and close SCM working session runtime records.

## Scope

- Run focused SCM, engine, and docs validation.
- Confirm provider-neutral vocabulary.
- Advance to client diagnostics read models.

## Acceptance Criteria

- SCM session cards are complete or rehomed.
- Git and non-Git workflows remain representable.
- Next ready card points to diagnostics read models.

## Validation

- `cargo test -p nucleus-scm-forge`
- `cargo test -p nucleus-engine`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if working-copy mutation must be implemented first.
