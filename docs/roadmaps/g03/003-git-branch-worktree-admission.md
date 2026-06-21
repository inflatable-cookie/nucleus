# 003 Git Branch Worktree Admission

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Admit Git branch/worktree execution intent from reviewable dry-run evidence
without creating branches, changing checkout state, or creating worktrees.

## Governing Refs

- `docs/roadmaps/g03/002-git-change-request-dry-run-runner.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/003-project-identity-contract.md`

## Goals

- [x] Admit branch/worktree intent only from reviewable dry-run evidence.
- [x] Preserve dry-run evidence, outcome, handoff, request, authority, plan,
  task, repo, and operator refs.
- [x] Keep primary-tree and isolated-worktree modes explicit.
- [x] Keep checkout, branch creation, and worktree creation false.
- [x] Route diagnostics without granting authority.

## Execution Plan

- [x] Branch/worktree admission records batch.
- [x] Command descriptor batch.
- [x] Preflight records batch.
- [x] Diagnostics batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/012-git-branch-worktree-admission-records.md`
- `batch-cards/013-git-branch-worktree-command-descriptors.md`
- `batch-cards/014-git-branch-worktree-preflight-records.md`
- `batch-cards/015-git-branch-worktree-diagnostics.md`
- `batch-cards/016-git-branch-worktree-closeout.md`

## Acceptance Criteria

- [x] Admission records reference reviewable dry-run evidence.
- [x] Primary-tree and isolated-worktree modes are explicit.
- [x] Non-reviewable dry-run evidence is blocked.
- [x] No checkout, branch, worktree, commit, push, pull-request, forge,
  provider, callback, interruption, recovery, or raw-output effect is executed.

## Closeout

Branch/worktree admission, descriptors, preflight, and diagnostics are complete.
The next lane is branch/worktree execution handoff so the Git branch/worktree
path can advance to explicit stopped-by-default command handoff before commit,
push, or pull-request authority is introduced.
