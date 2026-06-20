# 358 Task Transition Admission Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../078-task-transition-admission-from-live-observations.md`

## Purpose

Validate live-observation task transition admission and activate durable
wait/callback/recovery persistence.

## Scope

- Run targeted and workspace validation.
- Update roadmap and gap indexes.
- Keep one clear next task.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Task completion/review acceptance remain blocked.
- [x] `079` is activated only after transition rules are stable.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
