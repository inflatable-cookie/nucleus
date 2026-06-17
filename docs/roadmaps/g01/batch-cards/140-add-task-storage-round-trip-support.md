# 140 Add Task Storage Round Trip Support

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Support safe task create/update storage beyond display-only projection.

## Scope

- Add or refine storage record conversion needed for create/update.
- Preserve fields required by the task contract.
- Keep runtime and transcript data out of task storage.

## Out Of Scope

- Desktop create/edit UI.
- Runtime execution.
- Agent assignment.

## Promotion Targets

- `crates/nucleus-tasks`
- `crates/nucleus-server`

## Acceptance Criteria

- [x] Task records can round-trip for create/update-safe fields.
- [x] Display DTO projection remains stable.
- [x] Excluded runtime/provider data stays out of task storage.

## Result

Task storage now preserves readiness detail refs and can rebuild a domain task
from the create/update-safe storage projection. Server-owned history,
timestamps, runtime refs, command evidence, and provider data remain outside
the storage round-trip.
