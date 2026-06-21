# 030 Git Push Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../006-git-push-admission.md`

## Purpose

Summarize Git push admission, descriptor, and preflight state without granting
push authority.

## Acceptance Criteria

- [x] Diagnostics count admission, descriptor, and preflight states.
- [x] Diagnostics count blockers.
- [x] Diagnostics expose no raw output.
- [x] Diagnostics grant no push, pull-request, forge, provider, callback,
  interruption, recovery, task mutation, or raw-output authority.

## Validation

- [x] `cargo test -p nucleus-server git_push_diagnostics -- --nocapture`
- [x] `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- [x] `git diff --check`
