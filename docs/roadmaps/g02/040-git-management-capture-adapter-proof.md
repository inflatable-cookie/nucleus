# 040 Git Management Capture Adapter Proof

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Map neutral management capture preparation to Git-specific planning and
evidence without committing, pushing, or opening review requests.

This lane proves that Git can be the first concrete adapter target while core
records remain provider-neutral.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/039-scm-management-capture-and-share-foundation.md`
- `docs/roadmaps/long-term-plan.md`

## Goals

- [x] Define Git capture descriptor policy as an adapter mapping, not core
      vocabulary.
- [x] Add Git management capture plan records without executing commits.
- [x] Add dry-run command envelopes for Git capture readiness.
- [x] Link Git status/diff evidence to neutral capture records.
- [x] Keep push, commit, branch mutation, and review request creation gated.

## Execution Plan

- [x] Policy batch: clarify Git adapter mapping boundaries.
- [x] Plan batch: represent Git capture plans from neutral capture records.
- [x] Dry-run batch: define command envelopes that can inspect readiness
      without mutating SCM state.
- [x] Evidence batch: connect status and diff summaries to capture plans.
- [x] Validation batch: close the lane and select the next workflow checkpoint.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/181-git-capture-descriptor-policy.md`
- `batch-cards/182-git-management-capture-plan-records.md`
- `batch-cards/183-git-capture-command-envelope-dry-run.md`
- `batch-cards/184-git-capture-status-and-diff-evidence.md`
- `batch-cards/185-git-capture-validation-and-next-lane.md`

## Acceptance Criteria

- [x] Git capture behavior is represented as adapter mapping, not universal SCM
      vocabulary.
- [x] Git capture plans can be inspected without committing or pushing.
- [x] Evidence links remain traceable to neutral capture records.
- [x] The next lane is selected from the long-term plan.

## Gate

Do not execute Git commit, push, branch mutation, or review-request behavior in
this lane.

## Result

The lane added Git management capture plan records, dry-run command envelopes,
read-only check admission, and sanitized status/diff evidence linkage. Git
commit/push/branch/review-request terms remain adapter mapping labels, not
neutral management capture vocabulary.

The next lane is `041-scm-working-session-execution-prep.md`, focused on
primary-tree and isolated-worktree execution planning without provider
mutation.
