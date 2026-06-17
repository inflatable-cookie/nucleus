# 063 Working Copy Session Modes

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../017-scm-working-copy-and-change-request-workflows.md`

## Purpose

Model primary-tree and isolated worktree execution modes for human and agent
work.

## Scope

- Add neutral working-copy session records.
- Distinguish primary-tree temporary branch mode from isolated worktree mode.
- Record cleanup and single-runnable-instance constraints.
- Do not create branches or worktrees yet.

## Acceptance Criteria

- [x] Session records identify primary-tree versus isolated worktree mode.
- [x] Cleanup policy and user-testability constraints are explicit.
- [x] Git terminology does not become universal SCM terminology.

## Outcome

Added `nucleus-scm-forge::work_sessions` as a planning-only session surface.

The records now distinguish:

- primary project checkout sessions
- isolated checkout, worktree, or provider-managed location sessions
- external provider-managed sessions
- unsupported session modes

Session plans include cleanup policy, testability location, runtime
constraints, base change refs, intended targets, and provider-neutral isolation
surfaces. They do not create branches, create worktrees, switch refs, merge, or
delete files.

## Validation

- [x] `cargo test -p nucleus-scm-forge`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if session mode policy needs UI decisions before records can be named.
