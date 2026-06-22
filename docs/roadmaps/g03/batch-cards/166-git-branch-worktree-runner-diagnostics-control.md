# 166 Git Branch Worktree Runner Diagnostics Control

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../050-git-branch-worktree-runner-proof.md`

## Purpose

Expose branch/worktree runner state through read-only diagnostics/control DTOs.

## Acceptance Criteria

- [x] Diagnostics summarize runner outcomes and repair states.
- [x] Control DTOs expose counts and refs only.
- [x] Clients receive no SCM mutation authority from diagnostics.
- [x] Existing warning-sized request/control files are split if touched.

## Validation

- `cargo test -p nucleus-server git_branch_worktree`
- `cargo check -p nucleus-server`
- `effigy doctor`
- `git diff --check`
