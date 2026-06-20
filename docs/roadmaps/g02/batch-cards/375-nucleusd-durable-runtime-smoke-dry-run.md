# 375 Nucleusd Durable Runtime Smoke Dry Run

Status: completed
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

- [x] Dry-run reports eligible/blocked without provider write.
- [x] Real execution remains separately gated.
- [x] Output is sanitized.
- [x] CLI tests cover blocked and eligible paths.

## Result

Added `nucleusd command-runner durable-runtime-smoke`, stopped by default. It
reports replay eligibility, real-write confirmation/effect flags, sanitized
counts, and `provider_write_executed=false`.

## Validation

- `cargo test -p nucleusd durable_runtime_smoke -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
