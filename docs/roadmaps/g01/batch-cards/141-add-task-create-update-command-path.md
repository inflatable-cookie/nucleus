# 141 Add Task Create Update Command Path

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Add server-owned task create/update command support.

## Scope

- Add command DTO support for task create/update.
- Execute create/update through server state service.
- Preserve revision expectations for update.

## Out Of Scope

- Desktop create/edit UI.
- Agent assignment.
- Runtime execution.

## Promotion Targets

- `crates/nucleus-server`
- `crates/nucleus-tasks`

## Acceptance Criteria

- [x] Create writes a new task record.
- [x] Update changes supported editable fields.
- [x] Revision conflicts are explicit.
- [x] Read-after-write works through typed task DTOs.

## Result

The server command path now accepts task create/update authoring input through
control DTOs, writes through `ServerStateService`, validates project/title and
agent-readiness constraints, applies update revision checks, and proves
read-after-write through typed task DTO tests.
