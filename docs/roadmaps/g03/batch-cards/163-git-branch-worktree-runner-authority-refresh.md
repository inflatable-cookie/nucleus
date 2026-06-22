# 163 Git Branch Worktree Runner Authority Refresh

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../050-git-branch-worktree-runner-proof.md`

## Purpose

Refresh the existing Git branch/worktree admission, preflight, and handoff
records before adding a real runner.

## Acceptance Criteria

- [x] Existing branch/worktree records are mapped to the runner inputs needed
  for primary-tree and isolated-worktree modes.
- [x] Explicit operator effect intent is named as required before runner
  execution.
- [x] Commit, push, PR, forge, provider, callback, interruption, recovery, task
  mutation, UI, remote transport, and raw-output authority remain blocked.
- [x] Warning-sized files touched by the lane are split instead of enlarged.

## Validation

- `cargo check -p nucleus-server`
- `effigy doctor`
- `git diff --check`
