# 122 Add Task Record Storage Codec Or Display Projection

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Make server-owned task records display-ready without involving desktop
authority.

## Scope

- Add a Rust-owned task storage codec in `nucleus-tasks`.
- Add a server-owned task display projection for stored task records.
- Preserve stable task id, project id, title, activity, action type, and
  importance.
- Keep storage payloads server-owned.

## Out Of Scope

- Task list UI.
- Task mutation.
- Agent assignment.

## Promotion Targets

- `crates/nucleus-tasks`
- `crates/nucleus-server`
- `docs/architecture/system-inventory.md`

## Acceptance Criteria

- Server can expose display-ready task fields for stored task records.
- Tests prove ids, title, project id, activity, action type, and importance are
  preserved.
- No TypeScript task authority is introduced.

## Notes

Mirror the project record pattern. Prefer a narrow codec and DTO over expanding
task mutation behavior.

## Result

Added `nucleus-tasks` JSON task storage codec and a server-owned
`task_records` control response projection.

The first display DTO preserves:

- task id
- project id
- title
- description
- importance
- action type
- activity
- assignment intent
- agent-readiness flag
- storage revision id

No TypeScript task authority was added.
