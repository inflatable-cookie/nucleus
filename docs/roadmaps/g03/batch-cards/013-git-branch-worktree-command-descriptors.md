# 013 Git Branch Worktree Command Descriptors

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../003-git-branch-worktree-admission.md`

## Purpose

Describe branch/worktree commands from admitted records without executable
argv or shell handoff.

## Acceptance Criteria

- [x] Descriptors reference admission ids.
- [x] Primary-tree and isolated-worktree descriptors stay distinct.
- [x] Blocked admissions do not produce ready descriptors.
- [x] No command runs.

## Validation

- [x] `cargo test -p nucleus-server git_branch_worktree_command_descriptors -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
