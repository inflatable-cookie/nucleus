# 357 Review Readiness From Live Observations

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../078-task-transition-admission-from-live-observations.md`

## Purpose

Derive review readiness from completed live observations without accepting
review.

## Scope

- Require completed runtime plus validation, checkpoint, diff, receipt, or
  no-change evidence.
- Produce review-readiness records.
- Block review acceptance and task completion.

## Acceptance Criteria

- [ ] Completed runtime can become awaiting-review readiness.
- [ ] Missing review evidence blocks readiness.
- [ ] Review acceptance remains operator-command gated.
- [ ] Task completion remains separate.

## Validation

- `cargo test -p nucleus-server review_readiness_from_live_observations -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
