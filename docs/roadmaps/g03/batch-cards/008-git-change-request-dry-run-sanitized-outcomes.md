# 008 Git Change Request Dry-Run Sanitized Outcomes

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../002-git-change-request-dry-run-runner.md`

## Purpose

Record sanitized dry-run outcomes for Git change-request runner handoffs.

## Scope

- Completed, blocked, failed, and timed-out outcomes.
- Sanitized counts and evidence refs.
- No raw stdout/stderr retention.

## Acceptance Criteria

- [x] Outcomes reference handoff ids.
- [x] Outcome statuses are explicit.
- [x] Raw output is not retained.
- [x] Git mutation remains false.

## Validation

- [x] `cargo test -p nucleus-server git_change_request_dry_run_sanitized_outcomes -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
