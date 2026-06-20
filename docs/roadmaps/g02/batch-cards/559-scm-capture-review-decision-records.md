# 559 SCM Capture Review Decision Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../119-scm-capture-review-decision-persistence.md`

## Purpose

Define explicit operator review decision records over SCM capture review
readiness.

## Scope

- Add accepted, rejected, needs-changes, and abandoned decision states.
- Reference readiness ids, workflow ids, repo ids, and operator refs.
- Keep decision records separate from change-request preparation.

## Acceptance Criteria

- [x] Decision records preserve readiness and workflow refs.
- [x] Decision status vocabulary is explicit.
- [x] Accepted decisions require review-ready readiness.
- [x] Rejected, needs-changes, and abandoned decisions remain visible.

## Validation

- `cargo test -p nucleus-server scm_capture_review_decision_records -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
