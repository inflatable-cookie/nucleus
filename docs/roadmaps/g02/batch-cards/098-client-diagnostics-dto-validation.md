# 098 Client Diagnostics DTO Validation

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../023-client-read-model-and-diagnostics-runway.md`

## Purpose

Validate and close the diagnostics read-model runway.

## Scope

- Run focused server, engine, SCM, native harness, and docs validation.
- Confirm DTOs preserve server authority.
- Decide next planning checkpoint.

## Acceptance Criteria

- Diagnostics cards are complete or rehomed.
- Clients can inspect state without owning it.
- Next roadmap pointer is explicit.

## Validation

- `cargo test -p nucleus-server`
- `cargo test -p nucleus-engine`
- `cargo test -p nucleus-native-harness`
- `cargo test -p nucleus-scm-forge`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if UI authority needs a new product decision.
