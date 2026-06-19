# 211 SCM Work Session Policy Type Split

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../047-scm-work-sessions-module-split.md`

## Purpose

Split SCM work-session policy and plan types into focused modules.

## Scope

- Keep `work_sessions.rs` as the module front door if useful.
- Move session mode, location, testability, guard check, and cleanup policy
  groups into named files.
- Preserve public re-exports.

## Acceptance Criteria

- Public imports still compile.
- No SCM execution behavior is added.

## Validation

- `cargo test -p nucleus-scm-forge work_session`
- `cargo check --workspace`

## Stop Conditions

- Stop if public API churn spreads outside re-export wiring.
