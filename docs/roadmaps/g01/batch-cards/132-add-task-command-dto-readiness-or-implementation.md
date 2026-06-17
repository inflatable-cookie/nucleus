# 132 Add Task Command DTO Readiness Or Implementation

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Prepare the control envelope to carry task mutation commands.

## Scope

- Add command DTO support for the first task mutation subset.
- Support start, block, complete, and archive task commands.
- Carry task id and optional expected revision.
- Carry block reason for block commands.
- Preserve protocol version and unsupported payload behavior.

## Out Of Scope

- Desktop mutation UI.
- Runtime task execution.
- Agent assignment.

## Promotion Targets

- `crates/nucleus-server`
- `docs/architecture/system-inventory.md`

## Acceptance Criteria

- Task command DTO shape is implemented for the first transition subset.
- Unsupported commands still fail explicitly.
- No desktop mutation UI is added.

## Result

Implemented command DTO support for the first task transition subset:

- start
- block with reason
- complete
- archive

The DTO carries command id, task id, optional expected revision, and block
reason where needed. Task create and full update command DTOs still fail
explicitly as deferred shapes. No desktop mutation UI was added.
