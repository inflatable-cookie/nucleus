# 098 Client Diagnostics DTO Validation

Status: completed
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

- [x] Diagnostics cards are complete or rehomed.
- [x] Clients can inspect state without owning it.
- [x] Next roadmap pointer is explicit.

## Outcome

- Validated server, engine, native harness, SCM, docs, roadmap pointer, and
  formatting gates.
- Set the next roadmap pointer to a planning checkpoint.

## Validation

- [x] `cargo test -p nucleus-server`
- [x] `cargo test -p nucleus-engine`
- [x] `cargo test -p nucleus-native-harness`
- [x] `cargo test -p nucleus-scm-forge`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if UI authority needs a new product decision.
