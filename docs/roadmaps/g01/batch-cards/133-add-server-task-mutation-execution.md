# 133 Add Server Task Mutation Execution

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Execute the first task mutation subset through server-owned state handling.

## Scope

- Route supported task transition commands to task storage updates.
- Preserve revision expectations.
- Keep runtime execution out of state mutation handling.

## Out Of Scope

- Desktop mutation UI.
- Agent assignment.
- Runtime execution.

## Promotion Targets

- `crates/nucleus-server`
- `crates/nucleus-tasks`
- `docs/architecture/system-inventory.md`

## Acceptance Criteria

- Supported task commands change task records durably.
- Unsupported commands remain explicit.
- Read-after-write works through the typed task DTO boundary.

## Result

Implemented server execution for the first task transition subset:

- start sets activity to active
- block sets activity to blocked
- complete sets activity to done
- archive sets activity to archived

The handler reads existing task records through `ServerStateService`, decodes
typed task storage payloads, updates only activity state, preserves other
stored display fields, writes through the task repository, and returns
not-found/conflict/invalid-storage errors as rejected command receipts.

Task create and full update execution remain explicitly deferred. Runtime
execution and agent assignment remain out of scope.
