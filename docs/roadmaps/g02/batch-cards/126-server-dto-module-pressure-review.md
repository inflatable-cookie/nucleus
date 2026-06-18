# 126 Server DTO Module Pressure Review

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../029-health-and-module-boundary-reset.md`

## Purpose

Prevent the next runtime lane from expanding already-large server DTO and
request-handler files.

## Scope

- Review current warning-sized server files.
- Name files that must split before accepting task-agent DTO growth.
- Add planning notes only unless a small split is clearly mechanical.

## Acceptance Criteria

- [x] Server pressure points are named.
- [x] Task-agent DTO work has a target module location.
- [x] No runtime behavior is added.

## Result

Server pressure was reduced through module splits instead of docs-only
deferral. New task-agent DTO work should extend the focused DTO modules under
`crates/nucleus-server/src/control_envelope_dto/` and avoid growing
request-handler or response front-door files.

## Validation

- `cargo test -p nucleus-server control_envelope_dto::tests::response`
- `effigy doctor`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if this turns into broad server refactoring.
