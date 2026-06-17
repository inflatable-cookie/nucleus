# 130 Reassess Task Mutation Command Readiness

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Decide whether task mutation commands can be planned.

## Scope

- Check server command handling readiness.
- Check task storage update semantics.
- Decide whether task creation, editing, assignment, or execution should be
  planned next.

## Out Of Scope

- Implementing task mutation.
- Implementing assignment.
- Implementing execution.

## Promotion Targets

- `docs/roadmaps/g01`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Mutation readiness is explicit.
- Missing server authority remains visible.
- The next task lane is bounded.

## Result

Task mutation command readiness is not ready for UI controls.

Evidence:

- `TaskCommand` names create, update, start, block, complete, and archive.
- The local request handler currently returns accepted mutation receipts for
  task commands.
- It does not execute task storage mutations.
- The first control envelope does not serialize command DTOs.
- Desktop mutation controls would have no durable server-owned execution path.

Next lane: server task mutation command boundary readiness. Start by compiling
the exact task mutation semantics and command DTO runway before implementing
desktop controls.
