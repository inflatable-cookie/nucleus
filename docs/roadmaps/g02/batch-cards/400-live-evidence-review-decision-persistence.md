# 400 Live Evidence Review Decision Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../087-explicit-live-evidence-review-acceptance.md`

## Purpose

Persist explicit live evidence review decisions by reference.

## Scope

- Persist accepted, rejected, needs-changes, and abandoned decisions.
- Link readiness id, observation id, task id, work item id, reviewer ref, and
  evidence refs.
- Reject raw provider material and task completion.
- Preserve duplicate decision handling.

## Acceptance Criteria

- [x] Review decisions survive reopen.
- [x] Duplicate decisions are deterministic.
- [x] Raw material and task completion requests are rejected.
- [x] Decision records remain reference-only.

## Validation

- `cargo test -p nucleus-server live_evidence_review_decision_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
