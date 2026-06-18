# 102 Diagnostics Query Fixture Tests

Status: completed
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

- [x] Empty diagnostics are stable.
- [x] Populated diagnostics serialize expected refs and states.
- [x] Raw output and provider payloads stay absent.

## Outcome

- Added handler fixture tests for diagnostics snapshot and per-domain queries.
- Reused diagnostics read-model tests for populated serialization evidence.

## Validation

- [x] `cargo test -p nucleus-server diagnostics`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if fixtures need live provider or SCM commands.
