# 012 Git Branch Worktree Admission Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../003-git-branch-worktree-admission.md`

## Purpose

Define Git branch/worktree admission records from reviewable dry-run evidence.

## Scope

- Preserve dry-run evidence refs.
- Support primary-tree and isolated-worktree modes.
- Block non-reviewable evidence.
- Keep all Git effects false.

## Acceptance Criteria

- [x] Admission records reference dry-run evidence ids.
- [x] Worktree mode is explicit.
- [x] Non-reviewable evidence is blocked.
- [x] No checkout, branch, worktree, or forge effect is executed.

## Validation

- [x] `cargo test -p nucleus-server git_branch_worktree_admission_records -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
