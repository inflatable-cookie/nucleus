# 022 Git Commit Admission Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../005-git-commit-admission.md`

## Purpose

Define Git commit admission records from reviewable branch/worktree evidence.

## Scope

- Preserve branch/worktree evidence refs.
- Preserve upstream dry-run and branch/worktree identity.
- Require explicit commit message source.
- Keep all commit, push, pull-request, forge, provider, callback,
  interruption, recovery, task mutation, and raw-output effects false.

## Acceptance Criteria

- [x] Admission records reference branch/worktree evidence ids.
- [x] Commit message source is explicit.
- [x] Non-reviewable evidence is blocked.
- [x] No commit, push, pull-request, or forge effect is executed.

## Validation

- [x] `cargo test -p nucleus-server git_commit_admission_records -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
