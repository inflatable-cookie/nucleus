# 212 SCM Work Session Recovery Type Split

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../047-scm-work-sessions-module-split.md`

## Purpose

Split SCM work-session recovery records from session planning types.

## Scope

- Move recovery record and recovery state types into a focused module.
- Keep cleanup and repair semantics unchanged.

## Acceptance Criteria

- Recovery types remain publicly available.
- Existing tests still pass.

## Validation

- `cargo test -p nucleus-scm-forge work_session`
- `cargo check --workspace`

## Stop Conditions

- Stop if recovery semantics need redesign.
