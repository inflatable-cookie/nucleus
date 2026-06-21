# 017 Git Branch Worktree Execution Handoff

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../004-git-branch-worktree-execution-handoff.md`

## Purpose

Create execution handoff records from ready branch/worktree preflight records.

## Scope

- Admit ready preflight records.
- Block non-ready preflight records.
- Preserve all upstream refs needed for audit and later runner work.
- Keep every Git, forge, provider, callback, interruption, recovery, task
  mutation, and raw-output effect false.

## Acceptance Criteria

- [x] Ready preflight records produce admitted handoff records.
- [x] Non-ready preflight records produce blocked handoff records.
- [x] Handoff records preserve upstream ids and worktree mode.
- [x] No command runs.

## Validation

- [x] `cargo test -p nucleus-server git_branch_worktree_execution_handoff -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
