# 014 Git Branch Worktree Preflight Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../003-git-branch-worktree-admission.md`

## Purpose

Model preflight checks for branch/worktree command descriptors.

## Acceptance Criteria

- [x] Preflight records require explicit operator confirmation.
- [x] Dirty or missing working tree state is blocked.
- [x] Isolated worktree target availability is visible.
- [x] No command runs.

## Validation

- [x] `cargo test -p nucleus-server git_branch_worktree_preflight_records -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
