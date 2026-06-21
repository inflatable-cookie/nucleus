# 018 Git Branch Worktree Sanitized Outcomes

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../004-git-branch-worktree-execution-handoff.md`

## Purpose

Model sanitized outcomes for branch/worktree handoff attempts without retaining
raw command output.

## Acceptance Criteria

- [x] Outcome records distinguish completed, failed, timed-out, blocked, and
  cleanup-required states.
- [x] Outcome records preserve handoff, preflight, descriptor, admission, and
  evidence refs.
- [x] Outcome records store bounded counts/status only.
- [x] No command runs.

## Validation

- [x] `cargo test -p nucleus-server git_branch_worktree_sanitized_outcomes -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
