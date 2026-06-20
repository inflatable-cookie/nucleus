# 561 SCM Capture Review Decision Duplicate Blocked

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../119-scm-capture-review-decision-persistence.md`

## Purpose

Block duplicate review decisions and invalid acceptance of blocked readiness.

## Scope

- Reject duplicate decision ids.
- Prevent accepted decisions over blocked or repair-required readiness.
- Preserve rejected, needs-changes, and abandoned decisions for non-ready
  readiness.

## Acceptance Criteria

- [x] Duplicate decision ids are rejected.
- [x] Blocked readiness cannot be accepted.
- [x] Repair-required readiness cannot be accepted.
- [x] Non-accepting decisions preserve blocked evidence.

## Validation

- `cargo test -p nucleus-server scm_capture_review_decision_duplicate_blocked -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
