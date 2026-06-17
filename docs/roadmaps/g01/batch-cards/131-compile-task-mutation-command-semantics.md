# 131 Compile Task Mutation Command Semantics

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Define the first durable semantics for task mutation commands.

## Scope

- Review `TaskCommand` variants.
- Decide first supported mutation subset.
- Define create/update/state-transition storage behavior.
- Define explicit unsupported paths.

## Out Of Scope

- Implementing command execution.
- Adding desktop mutation controls.
- Agent assignment.
- Runtime execution.

## Promotion Targets

- `docs/roadmaps/g01/018-task-mutation-command-boundary-readiness.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- First supported task mutation subset is explicit.
- Storage update behavior is explicit.
- Unsupported command paths remain visible.
- Next implementation card is narrow.

## Result

First supported task mutation subset:

- start existing task
- block existing task with reason
- complete existing task
- archive existing task

Deferred:

- create task
- full update task
- assignment changes
- agent execution
- validation command execution
- SCM work session creation

Storage behavior:

- read through `ServerStateService`
- require an existing task record
- decode the typed task storage payload
- update only activity state
- preserve all other stored display fields
- write back through the task repository
- support exact revision checks for client-originated commands once command
  DTOs expose revision ids

Next implementation card: add task command DTO support for the first transition
subset.
