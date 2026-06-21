# 004 Git Branch Worktree Execution Handoff

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Model stopped-by-default execution handoff for Git branch/worktree commands
after preflight is ready.

This lane does not create branches, change checkout state, create worktrees, or
run Git. It creates the records a later runner must satisfy before any effect
can be attempted.

## Governing Refs

- `docs/roadmaps/g03/003-git-branch-worktree-admission.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/003-project-identity-contract.md`

## Goals

- [x] Admit execution handoff only from ready branch/worktree preflight records.
- [x] Preserve preflight, descriptor, admission, dry-run evidence, request,
  authority, plan, task, repo, and operator refs.
- [x] Keep primary-tree and isolated-worktree execution modes explicit.
- [x] Store only sanitized branch/worktree outcomes and evidence.
- [x] Keep checkout, branch creation, worktree creation, commit, push,
  pull-request, forge, provider, callback, interruption, recovery, and
  raw-output effects false.

## Execution Plan

- [x] Execution handoff records batch.
- [x] Sanitized outcome records batch.
- [x] Evidence records batch.
- [x] Diagnostics batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/017-git-branch-worktree-execution-handoff.md`
- `batch-cards/018-git-branch-worktree-sanitized-outcomes.md`
- `batch-cards/019-git-branch-worktree-evidence.md`
- `batch-cards/020-git-branch-worktree-execution-diagnostics.md`
- `batch-cards/021-git-branch-worktree-execution-closeout.md`

## Acceptance Criteria

- [x] Execution handoff records admit ready preflight records only.
- [x] Blocked handoff records preserve blocker refs without running commands.
- [x] Evidence records retain sanitized counts/status only.
- [x] Diagnostics summarize handoff, outcome, and evidence state read-only.
- [x] No external effect is executed.

## Closeout

This lane establishes branch/worktree execution handoff as a stopped-by-default
record chain. It preserves upstream identity, sanitized outcome state, evidence,
and diagnostics without running Git. Commit admission can now depend on
reviewable branch/worktree evidence.
