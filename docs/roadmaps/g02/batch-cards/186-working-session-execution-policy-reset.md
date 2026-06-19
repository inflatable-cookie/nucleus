# 186 Working Session Execution Policy Reset

Status: completed
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

## Result

`docs/contracts/011-scm-forge-sync-contract.md` now defines working-session
execution prep as a reviewable pre-provider boundary. Checkout, worktree
creation, cleanup, merge, and deletion remain gated.
