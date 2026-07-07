# 059 Selected Task Review Decision Outcome Validation

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../012-selected-task-review-decision-controls.md`

## Purpose

Validate the review-decision lane and select the next product phase.

## Work

- [x] Run focused server, CLI, Effigy, desktop, docs, and Northstar validation.
- [x] Confirm selected-task review/next-step and SCM handoff read models reflect
  decisions.
- [x] Confirm no forbidden provider, SCM, memory, planning, task lifecycle, or
  final UI effects were added.
- [x] Decide whether the next phase is agent delegation scheduling, panel/UI
  foundation, task lifecycle transition from accepted review, or generation
  closeout.

## Acceptance Criteria

- [x] Review decisions work through the same boundary across server, CLI,
  Effigy, and desktop proof.
- [x] Validation passes or failures are recorded with clear remediation.
- [x] The next task points to a ready card or explicit planning checkpoint.

## Result

Focused validation passed across the selected-task review-decision lane:

- `cargo test -p nucleus-server selected_task_review_decision -- --nocapture`
- `cargo test -p nucleusd selected_task_review_decision -- --nocapture`
- `effigy server:query:selected-task-review-decision-admission`
- `effigy server:query:selected-task-review-decision-apply:blocked-smoke`
- `effigy desktop:check`
- `cargo test -p nucleus-desktop panel_guards -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `effigy doctor`

Doctor remains warning-only with god-file findings.

The next phase is selected-task review outcome routing. Review decisions are
now recordable, but accepting evidence must not complete a task by itself.
Rejected, needs-changes, and abandoned outcomes also need explicit routing into
rework, delegation, blocked, or planning states before any later mutation can
be admitted.
