# 090 Git Session Admission Records

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../022-scm-working-session-runtime.md`

## Purpose

Map Git branch and worktree possibilities into neutral admission records.

## Scope

- Represent primary-tree and isolated-worktree admission.
- Capture testability and cleanup constraints.
- Keep Git-specific terms adapter-scoped.

## Acceptance Criteria

- [x] Git branch/worktree labels do not leak into neutral core vocabulary.
- [x] Admission can represent blocked or unsupported runtime constraints.
- [x] No Git command is executed.

## Outcome

- Added admission records for Git-like primary and isolated session plans.
- Admission can accept, block, require approval, reject, or report unsupported
  capabilities without running Git.

## Validation

- [x] `cargo test -p nucleus-scm-forge git`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if admission needs to create a branch or worktree.
