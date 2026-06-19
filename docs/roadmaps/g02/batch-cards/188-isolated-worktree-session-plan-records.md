# 188 Isolated Worktree Session Plan Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../041-scm-working-session-execution-prep.md`

## Purpose

Model per-thread isolated worktree session plans.

## Scope

- Add records for base ref, isolated path, temporary change ref, and cleanup
  expectations.
- Represent user-testability constraints.
- Do not create worktrees or branches.

## Acceptance Criteria

- Isolated worktree session plans are explicit and reviewable.
- Plans can represent blocked states for path or runtime conflicts.

## Validation

- Targeted Rust tests for isolated worktree session plans.
- `cargo check --workspace`

## Stop Conditions

- Stop if cleanup or repair expectations are not representable.

## Result

Isolated-location session execution prep now records location review, cleanup
policy review, runtime constraints, and testability tradeoffs without creating
worktrees or branches.
