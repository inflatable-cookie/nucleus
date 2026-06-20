# 550 SCM Capture Review Blockers

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../117-scm-capture-operator-review-readiness.md`

## Purpose

Surface blockers for workflows that are not ready for operator review.

## Scope

- Distinguish missing, blocked, repair-required, and not-completed stages.
- Preserve partial evidence.
- Avoid collapsing blocked states into generic failure.

## Acceptance Criteria

- [x] Missing stages produce blockers.
- [x] Blocked stages produce blockers.
- [x] Repair-required stages produce blockers.
- [x] Partial evidence remains inspectable.

## Validation

- `cargo test -p nucleus-server scm_capture_review_blockers -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
