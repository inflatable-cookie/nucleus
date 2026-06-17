# 135 Add Desktop Task Transition Command Helpers

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Let TypeScript construct first-subset task transition command DTOs.

## Scope

- Add command DTO types for task transitions.
- Add helper builders for start, block, complete, and archive.
- Include task id and expected revision.
- Include block reason for block commands.

## Out Of Scope

- UI buttons.
- Task creation/edit helpers.
- Agent execution helpers.

## Promotion Targets

- `apps/desktop/src/lib/control.ts`
- `apps/desktop/README.md`

## Acceptance Criteria

- Helpers produce control command envelopes for supported task transitions.
- Unsupported mutation helpers are not added.
- TypeScript remains DTO construction and view glue.

## Validation

```sh
bun run check
bun run build
```

## Result

Added TypeScript command DTO helpers for the supported task transition subset:

- start
- block with reason
- complete
- archive

Helpers include task id and expected revision from the selected task DTO. No
task creation, full edit, assignment, or execution helpers were added.
