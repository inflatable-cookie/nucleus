# 581 SCM Change Request Convergence-Like Plan

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../123-scm-change-request-adapter-plan-selection.md`

## Purpose

Map adapter-neutral preparation admissions to convergence-like change-request
plans.

## Scope

- Scope snapshot and publish terms to convergence-like plan records.
- Avoid assuming commits are the universal unit.
- Preserve admission evidence refs.

## Acceptance Criteria

- [x] Convergence-like plans carry snapshot/publish terminology.
- [x] Admission refs are preserved.
- [x] Evidence refs are preserved.
- [x] No snapshot/publish effect is executed.

## Validation

- [x] `cargo test -p nucleus-server scm_change_request_convergence_like_plan -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
