# 031 Selected Task Command Admission Boundary

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../007-selected-task-command-admission-controls.md`

## Purpose

Define how selected-task operator gate candidates may become admitted task
commands.

## Work

- [x] Confirm the only admitted actions are start, block, complete, and
  archive.
- [x] Define required operator intent fields.
- [x] Define expected revision and block reason requirements.
- [x] Define how blocked, read-only, and deferred gate candidates are refused.
- [x] Define stop conditions for provider, SCM, delegation, review acceptance,
  active apply, final UI, and client authority.

## Acceptance Criteria

- [x] The server admission proof can be implemented without guessing.
- [x] Task mutation remains explicit and server-owned.
- [x] Deferred lanes remain deferred.

## Result

Only `start_selected_task`, `block_selected_task`, `complete_selected_task`,
and `archive_selected_task` may be admitted.

Required operator intent fields:

- action family
- expected revision for every mutating task command
- block reason for `block_selected_task`
- operator ref

Blocked, read-only, deferred, missing, mismatched, or unsupported candidates
are refused before any task command is returned.

Stop conditions remain provider execution, SCM/forge execution, delegation
scheduling, review acceptance, active memory/planning apply, final UI, client
state authority, and widening beyond task-only transitions.
