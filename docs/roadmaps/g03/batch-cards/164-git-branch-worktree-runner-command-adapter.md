# 164 Git Branch Worktree Runner Command Adapter

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../050-git-branch-worktree-runner-proof.md`

## Purpose

Add the constrained command adapter that converts accepted branch/worktree
handoff records into Git command requests.

## Acceptance Criteria

- [x] Command construction is argv-based, not shell-passthrough.
- [x] Working directory and target path policy are validated before execution.
- [x] Primary-tree and isolated-worktree modes produce distinct command plans.
- [x] The adapter cannot create commits, push refs, call forge APIs, or retain
  raw output.

## Validation

- `cargo test -p nucleus-server git_branch_worktree`
- `cargo check -p nucleus-server`
- `git diff --check`
