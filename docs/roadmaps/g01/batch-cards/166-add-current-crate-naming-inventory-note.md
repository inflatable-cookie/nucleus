# 166 Add Current Crate Naming Inventory Note

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Record that current `nucleus-server` naming is historical and currently means
host API/runtime boundary.

## Scope

- Update system inventory.
- Note that crate renaming is deferred.
- Keep `nucleus-server` usable for sidecar/remote/embedded IPC types.

## Out Of Scope

- Crate rename.
- Module refactor.

## Promotion Targets

- `docs/architecture/system-inventory.md`

## Acceptance Criteria

- Inventory reflects engine-first correction.
- Future refactor risk is visible.

## Closeout

- Added inventory note that `nucleus-server` currently means host API/runtime
  boundary and may later split reusable engine services from host wrappers.
