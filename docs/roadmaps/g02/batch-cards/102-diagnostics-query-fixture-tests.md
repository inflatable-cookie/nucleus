# 102 Diagnostics Query Fixture Tests

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../024-diagnostics-control-api-query-surface.md`

## Purpose

Prove diagnostics query behavior with empty and populated fixtures.

## Scope

- Add fixture tests for diagnostics queries.
- Cover empty, unsupported, and populated paths where practical.
- Confirm diagnostics remain sanitized.

## Acceptance Criteria

- Empty diagnostics are stable.
- Populated diagnostics serialize expected refs and states.
- Raw output and provider payloads stay absent.

## Validation

- `cargo test -p nucleus-server diagnostics`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if fixtures need live provider or SCM commands.
