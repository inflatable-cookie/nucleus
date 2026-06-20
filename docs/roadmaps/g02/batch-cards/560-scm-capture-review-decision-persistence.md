# 560 SCM Capture Review Decision Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../119-scm-capture-review-decision-persistence.md`

## Purpose

Persist SCM capture operator review decisions in local state.

## Scope

- Add persistence input and record shapes.
- Add write/read helpers with stable ordering.
- Preserve decision refs without raw output.

## Acceptance Criteria

- [x] Decisions persist by stable id.
- [x] Reads return deterministic ordering.
- [x] Persisted records retain operator and readiness refs.
- [x] Raw output remains absent.

## Validation

- `cargo test -p nucleus-server scm_capture_review_decision_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
