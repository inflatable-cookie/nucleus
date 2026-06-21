# 025 Git Commit Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../005-git-commit-admission.md`

## Purpose

Summarize Git commit admission, descriptor, and preflight state without
granting commit authority.

## Acceptance Criteria

- [x] Diagnostics count admission, descriptor, and preflight states.
- [x] Diagnostics count blockers.
- [x] Diagnostics expose no raw output.
- [x] Diagnostics grant no commit, push, pull-request, forge, provider,
  callback, interruption, recovery, task mutation, or raw-output authority.

## Validation

- [x] `cargo test -p nucleus-server git_commit_diagnostics -- --nocapture`
- [x] `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- [x] `git diff --check`
