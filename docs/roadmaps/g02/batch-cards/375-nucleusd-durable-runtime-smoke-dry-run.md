# 375 Nucleusd Durable Runtime Smoke Dry Run

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../082-task-backed-live-workflow-closeout.md`

## Purpose

Add a stopped-by-default `nucleusd` smoke dry-run for the durable runtime path.

## Scope

- Expose dry-run eligibility and blockers.
- Require separate explicit effect flag for real provider writes.
- Retain sanitized ids, counts, statuses, and evidence refs only.

## Acceptance Criteria

- [ ] Dry-run reports eligible/blocked without provider write.
- [ ] Real execution remains separately gated.
- [ ] Output is sanitized.
- [ ] CLI tests cover blocked and eligible paths.

## Validation

- `cargo test -p nucleusd durable_runtime_smoke -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
