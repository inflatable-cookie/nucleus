# 123 Add Local Task Seed Or Create Path

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Provide an intentional server-owned way for local storage to contain task
records.

## Scope

- Add a server-owned local task seed path.
- Attach seeded tasks to the local project.
- Route writes through server-owned state handling.

## Out Of Scope

- Full task creation UI.
- Agent assignment.
- Task execution.

## Promotion Targets

- `crates/nucleus-server`
- `crates/nucleus-tasks`
- `docs/architecture/system-inventory.md`

## Acceptance Criteria

- A local task record can be written through the selected server path.
- Read-after-write works through the control query boundary.
- Seed behavior is distinct from full task mutation UI.

## Notes

Mirror `seed_local_project`. The local seed should produce one bootstrap task
attached to `project:nucleus-local` and use the `nucleus-tasks` storage codec.

## Result

Added `seed_local_task` and `LocalTaskSeed` in `nucleus-server`.

The local bootstrap task:

- uses `task:nucleus-local:bootstrap`
- attaches to `project:nucleus-local`
- writes through `ServerStateService`
- uses the `nucleus-tasks` storage codec
- is idempotent
- reads back through the control response DTO boundary as `task_records`

Desktop startup now seeds the local task after the local project seed. This is
bootstrap data only, not general task creation UI.
