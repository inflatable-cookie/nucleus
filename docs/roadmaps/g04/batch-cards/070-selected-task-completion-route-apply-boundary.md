# 070 Selected Task Completion Route Apply Boundary

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../015-selected-task-completion-from-route-admission.md`

## Purpose

Define how an admitted completion route becomes an explicit task completion
apply path.

## Work

- [x] Document required inputs: project id, task id, expected revision, operator
  ref, route admission id, review decision ref, and evidence refs.
- [x] Define refusal cases for missing route admission, stale route, stale task,
  missing reviewed evidence, refused command admission, and unsupported route.
- [x] Define the evidence and receipt refs the apply path must expose.
- [x] Keep route admission, command admission, and command apply as separate
  authority steps.

## Acceptance Criteria

- [x] Completion apply cannot be inferred from review route status alone.
- [x] Completion apply cannot be inferred from route admission alone.
- [x] Expected revision and operator intent are mandatory.
- [x] Rework, delegation, SCM, provider, memory, and planning effects are
  explicitly out of scope.

## Boundary

Required apply intent:

- project id
- task id
- expected task revision
- operator ref
- route admission id
- review decision ref
- reviewed evidence refs
- selected-task route admission record

The apply boundary may only expose an existing task `complete` command from an
admitted route. It must not execute that command, write task state, create
receipts, schedule agents, or mutate SCM, forge, memory, planning, projection,
provider, or UI state.

Refusal cases:

- project or task mismatch
- missing operator intent
- missing expected revision
- route admission id mismatch
- refused route admission
- missing or mismatched review decision ref
- missing or mismatched reviewed evidence refs
- missing or refused selected-task command admission
- unsupported non-complete command
- stale expected revision between apply intent and admitted command

Authority chain:

1. Review decision records prove operator review.
2. Review outcome route chooses the completion pathway.
3. Route admission proves the completion pathway can expose a task command.
4. Completion-from-route apply validates explicit operator intent against that
   admitted route and exposes the existing complete command.
5. A later server command boundary performs mutation and emits command receipt
   evidence.
