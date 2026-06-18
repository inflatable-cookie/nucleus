# 107 Diagnostics DTO Authority Guard Tests

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../025-diagnostics-control-dto-serialization.md`

## Purpose

Prove diagnostics DTOs cannot perform or imply mutation.

## Scope

- Add guard tests for client mutation flags.
- Reject raw command output and provider payload terms.
- Keep diagnostics separate from command request DTOs.

## Acceptance Criteria

- DTOs expose read-only state only.
- DTOs do not contain command request bodies.
- Sanitization rules are tested.

## Validation

- `cargo test -p nucleus-server diagnostics`
- `cargo test -p nucleus-server control_envelope`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if a diagnostics DTO needs command authority fields.
