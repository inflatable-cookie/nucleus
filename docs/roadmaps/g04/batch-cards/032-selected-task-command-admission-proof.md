# 032 Selected Task Command Admission Proof

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../007-selected-task-command-admission-controls.md`

## Purpose

Add the server-owned admission proof that converts eligible gate candidates into
existing task transition commands.

## Work

- [x] Add an admission request shape scoped to one gate candidate.
- [x] Validate task id, candidate family, expected revision, and block reason.
- [x] Refuse blocked, read-only, deferred, unknown, or mismatched candidates.
- [x] Reuse existing task command execution instead of creating a parallel
  mutation path.
- [x] Add focused tests for admitted and refused actions.

## Acceptance Criteria

- [x] Only task-domain commands are admitted.
- [x] Existing task command authority remains the mutation boundary.
- [x] Provider, SCM, delegation, review acceptance, memory apply, and planning
  apply are not introduced.

## Result

Added `selected_task_command_admission`, a server-side admission proof that
validates one selected-task operator gate candidate and operator intent.

The proof returns an existing `TaskCommand` for admitted task-only transitions.
It does not execute that command. Existing task command handling remains the
only mutation boundary.
