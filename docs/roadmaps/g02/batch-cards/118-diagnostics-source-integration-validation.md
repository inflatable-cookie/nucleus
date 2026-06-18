# 118 Diagnostics Source Integration Validation

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../027-diagnostics-read-model-source-integration.md`

## Purpose

Validate and close diagnostics source integration.

## Scope

- Run focused server, SCM, and docs validation.
- Confirm missing source domains are explicit.
- Advance to workflow selection.

## Acceptance Criteria

- [x] Source integration cards are complete or rehomed.
- [x] No query execution writes domain records.
- [x] Next ready card points to workflow selection.

## Outcome

Validated diagnostics source status across server, SCM, desktop DTO, and docs
surfaces. The next ready card points to workflow selection.

## Validation

- `cargo test -p nucleus-server diagnostics`
- `cargo test -p nucleus-scm-forge`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if source integration needs new persistence contracts.
