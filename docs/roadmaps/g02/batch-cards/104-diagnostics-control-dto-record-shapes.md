# 104 Diagnostics Control DTO Record Shapes

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../025-diagnostics-control-dto-serialization.md`

## Purpose

Expose diagnostics records through control DTO modules.

## Scope

- Add DTO record shapes for steward, Effigy, sync, and SCM diagnostics.
- Reuse server diagnostics read-model data.
- Keep DTOs transport-safe.

## Acceptance Criteria

- [x] DTO record shapes cover all diagnostics domains.
- [x] DTOs serialize without raw payload fields.
- [x] DTOs do not become storage records.

## Outcome

Added control diagnostics response DTOs for steward, Effigy, management sync,
SCM session, and combined snapshots, reusing diagnostics read-model data.

## Validation

- `cargo test -p nucleus-server diagnostics`
- `cargo test -p nucleus-server control_envelope`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if DTOs require direct storage mutation.
