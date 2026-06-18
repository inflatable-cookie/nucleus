# 099 Control API Diagnostics Query Kinds

Status: ready
Owner: Tom
Updated: 2026-06-18
Milestone: `../024-diagnostics-control-api-query-surface.md`

## Purpose

Name diagnostics query kinds in the transport-neutral control API.

## Scope

- Add query vocabulary for steward, Effigy, sync, and SCM diagnostics.
- Keep queries read-only.
- Keep diagnostics separate from command and state mutation APIs.

## Acceptance Criteria

- Diagnostics query kinds are explicit.
- Query kinds cannot imply mutation.
- Unsupported diagnostics can be represented.

## Validation

- `cargo test -p nucleus-server diagnostics`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if query vocabulary becomes a command surface.
