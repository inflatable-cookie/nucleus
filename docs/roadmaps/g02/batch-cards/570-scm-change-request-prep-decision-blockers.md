# 570 SCM Change Request Prep Decision Blockers

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../121-scm-capture-change-request-preparation-admission.md`

## Purpose

Block change-request preparation admission from non-accepted or invalid review
decisions.

## Scope

- Block rejected, needs-changes, and abandoned decisions.
- Block duplicate-noop and blocked persistence statuses.
- Preserve blocker evidence for operator repair.

## Acceptance Criteria

- [x] Rejected decisions are blocked.
- [x] Needs-changes decisions are blocked.
- [x] Abandoned decisions are blocked.
- [x] Duplicate or blocked decision records are blocked.

## Validation

- `cargo test -p nucleus-server scm_change_request_prep_decision_blockers -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
