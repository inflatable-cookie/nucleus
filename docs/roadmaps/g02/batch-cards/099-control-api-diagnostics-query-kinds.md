# 099 Control API Diagnostics Query Kinds

Status: completed
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

- [x] Diagnostics query kinds are explicit.
- [x] Query kinds cannot imply mutation.
- [x] Unsupported diagnostics can be represented.

## Outcome

- Added diagnostics query vocabulary to the transport-neutral control API.
- Kept diagnostics query kinds separate from command surfaces.

## Validation

- [x] `cargo test -p nucleus-server diagnostics`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if query vocabulary becomes a command surface.
