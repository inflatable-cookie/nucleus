# 521 Git Dry Run Execution Duplicate Blocked

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../111-git-dry-run-command-execution-persistence.md`

## Purpose

Treat duplicate Git dry-run execution ids as blocked no-ops without overwriting
terminal records.

## Scope

- Block duplicate execution ids.
- Preserve existing completed, failed, timed-out, blocked, and repair-required
  records.
- Reject raw output and mutating/external effect requests.

## Acceptance Criteria

- [x] Duplicate ids are blocked.
- [x] Existing terminal records are preserved.
- [x] Raw output requests are blocked.
- [x] Commit, checkout, branch, push, forge, provider, callback, interruption,
  and recovery requests are blocked.

## Validation

- `cargo test -p nucleus-server git_dry_run_execution_duplicate_blocked -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
