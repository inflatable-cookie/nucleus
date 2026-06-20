# 402 Live Evidence Task Completion Separation

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../087-explicit-live-evidence-review-acceptance.md`

## Purpose

Prove review acceptance still does not complete the task.

## Scope

- Add regressions across live evidence candidates, observations, readiness, and
  review decisions.
- Keep provider completion, review acceptance, and task completion distinct.
- Identify the future explicit task-completion command lane.

## Acceptance Criteria

- [x] Provider completion does not imply review acceptance.
- [x] Review acceptance does not imply task completion.
- [x] Rejected/needs-changes/abandoned decisions never complete tasks.
- [x] Future task completion lane is named but not implemented here.

## Validation

- `cargo test -p nucleus-server live_evidence_task_completion_separation -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
