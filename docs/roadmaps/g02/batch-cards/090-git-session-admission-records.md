# 090 Git Session Admission Records

Status: planned
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

- Git branch/worktree labels do not leak into neutral core vocabulary.
- Admission can represent blocked or unsupported runtime constraints.
- No Git command is executed.

## Validation

- `cargo test -p nucleus-scm-forge git`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if admission needs to create a branch or worktree.
