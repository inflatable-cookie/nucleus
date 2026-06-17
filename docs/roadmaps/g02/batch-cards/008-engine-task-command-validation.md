# 008 Engine Task Command Validation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Validate and close the engine task command boundary milestone.

## Scope

- Run focused engine/server tests.
- Run workspace compile.
- Run Northstar docs checks.
- Update milestone outcome and next pointer.

## Out Of Scope

- Large speculative suites.
- Provider harness tests.
- UI test work.

## Promotion Targets

- `docs/roadmaps/g02/003-engine-task-command-boundary.md`
- `docs/roadmaps/README.md`

## Acceptance Criteria

- [x] `cargo check --workspace` passes.
- [x] Focused engine/server tests pass.
- [x] `effigy qa:docs` passes.
- [x] `effigy qa:northstar` passes.
- [x] The milestone outcome clearly states the next lane.

## Stop Conditions

- Validation exposes a contract gap around task mutation authority.

## Outcome

Validated the engine task command boundary with focused engine/server tests,
workspace compile, and Northstar docs checks.
