# 399 Live Evidence Review Acceptance Admission

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../087-explicit-live-evidence-review-acceptance.md`

## Purpose

Admit explicit operator review decisions over live provider evidence
review-readiness records.

## Scope

- Require review-readiness status awaiting explicit review.
- Require operator ref and decision evidence refs.
- Support accept, reject, needs-changes, and abandon decisions.
- Reject task completion, provider writes, callback, cancellation, resume, and
  SCM authority.

## Acceptance Criteria

- [x] Accepted readiness plus operator evidence admits review decision.
- [x] Not-ready records block review decision.
- [x] Missing operator/evidence blocks review decision.
- [x] Admission does not complete the task.

## Validation

- `cargo test -p nucleus-server live_evidence_review_acceptance_admission -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
