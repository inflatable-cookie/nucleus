# 186 Working Session Execution Policy Reset

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../041-scm-working-session-execution-prep.md`

## Purpose

Define working-session execution authority before branch or worktree behavior
is modeled.

## Scope

- Clarify primary-tree and isolated-worktree session authority.
- Separate planning, admission, execution, cleanup, and repair.
- Do not run SCM mutation.

## Acceptance Criteria

- Execution policy is explicit enough for session records.
- Destructive operations remain gated.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if checkout/worktree authority cannot be bounded safely.
