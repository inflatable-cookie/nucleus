# 580 SCM Change Request Git-Like Plan

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../123-scm-change-request-adapter-plan-selection.md`

## Purpose

Map adapter-neutral preparation admissions to Git-like change-request plans.

## Scope

- Scope branch, commit, push, and PR terms to Git-like plan records.
- Keep execution authority false.
- Preserve admission evidence refs.

## Acceptance Criteria

- [x] Git-like plans carry Git-scoped terminology.
- [x] Admission refs are preserved.
- [x] Evidence refs are preserved.
- [x] No branch/commit/push/PR effect is executed.

## Validation

- [x] `cargo test -p nucleus-server scm_change_request_git_like_plan -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
