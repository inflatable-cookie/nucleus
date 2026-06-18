# 152 Task Work Review Timeline Projection

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../034-task-work-checkpoint-and-review-loop.md`

## Purpose

Project task work review state into task timeline/read models.

## Scope

- Add review entries to timeline projection.
- Include checkpoint and diff refs.
- Keep projection rebuildable.

## Acceptance Criteria

- [x] Review state appears in task timeline.
- [x] Timeline entries preserve source refs.
- [x] Projection is deterministic.

## Result

Added deterministic review timeline entry projection from review transitions,
including checkpoint and diff refs.

## Validation

- `cargo test -p nucleus-server task_transitions`
- `cargo test -p nucleus-engine task_agent`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if timeline semantics need another contract pass.
