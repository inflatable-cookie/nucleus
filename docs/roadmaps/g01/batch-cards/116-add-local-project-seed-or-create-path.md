# 116 Add Local Project Seed Or Create Path

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Provide an intentional server-owned way for local storage to contain project
records.

## Scope

- Add the chosen seed or create path.
- Route it through server-owned state handling.
- Keep command receipts honest about actual mutation behavior.

## Out Of Scope

- Full project management UI.
- Repo scanning.
- SCM/forge integration.

## Promotion Targets

- `crates/nucleus-server`
- `crates/nucleus-local-store`
- `docs/architecture/system-inventory.md`

## Acceptance Criteria

- [x] A local project record can be written through the selected server path.
- [x] Read-after-write works through the control query boundary.
- [x] Tests distinguish accepted receipts from completed mutations.

## Notes

- Added `LocalProjectSeed` and `seed_local_project` in `nucleus-server`.
- Desktop local state initialization seeds `Nucleus Local` through the server
  handler before creating the Tauri command adapter.
- Tests prove idempotent seed behavior and project-list readback through the
  control query path.
