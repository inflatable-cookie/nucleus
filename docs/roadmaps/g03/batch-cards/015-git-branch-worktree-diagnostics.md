# 015 Git Branch Worktree Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../003-git-branch-worktree-admission.md`

## Purpose

Summarize branch/worktree admission, descriptor, and preflight state.

## Acceptance Criteria

- [x] Diagnostics count modes.
- [x] Diagnostics count blockers.
- [x] Diagnostics expose no raw output.
- [x] Diagnostics grant no Git or forge authority.

## Validation

- [x] `cargo test -p nucleus-server git_branch_worktree_diagnostics -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
