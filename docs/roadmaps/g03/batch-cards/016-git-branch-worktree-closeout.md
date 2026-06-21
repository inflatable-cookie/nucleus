# 016 Git Branch Worktree Closeout

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../003-git-branch-worktree-admission.md`

## Purpose

Validate branch/worktree admission and choose the next Git execution lane.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Gap index reflects branch/worktree state.
- [x] Next lane is selected from evidence.
- [x] External effects remain gated.

## Validation

- [x] `cargo check --workspace`
- [x] `cargo test --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Closeout

Branch/worktree admission is ready for an execution handoff lane. The next
lane should model stopped-by-default shell handoff and sanitized outcomes for
checkout/branch/worktree commands before commit, push, or pull-request lanes.
