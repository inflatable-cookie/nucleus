# 396 Live Provider Evidence Review Readiness

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../086-durable-live-evidence-task-work-linkage.md`

## Purpose

Expose review readiness from durable live provider-write evidence without
accepting the review.

## Scope

- Build review-readiness records from completed/reconciled observations.
- Keep needs-review, accepted, rejected, and abandoned states explicit.
- Require operator action for acceptance.
- Keep task completion separate from provider completion.

## Acceptance Criteria

- [x] Completed live evidence can mark work review-ready.
- [x] Failed/blocked evidence cannot mark review-ready.
- [x] Review acceptance remains explicit.
- [x] Task completion remains explicit.

## Result

Added live provider evidence review-readiness records that can mark awaiting
explicit review without accepting review or completing tasks.

## Validation

- `cargo test -p nucleus-server live_provider_evidence_review_readiness -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
