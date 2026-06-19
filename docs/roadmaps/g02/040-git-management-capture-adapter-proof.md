# 040 Git Management Capture Adapter Proof

Status: active
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

- [ ] Define Git capture descriptor policy as an adapter mapping, not core
      vocabulary.
- [ ] Add Git management capture plan records without executing commits.
- [ ] Add dry-run command envelopes for Git capture readiness.
- [ ] Link Git status/diff evidence to neutral capture records.
- [ ] Keep push, commit, branch mutation, and review request creation gated.

## Execution Plan

- [ ] Policy batch: clarify Git adapter mapping boundaries.
- [ ] Plan batch: represent Git capture plans from neutral capture records.
- [ ] Dry-run batch: define command envelopes that can inspect readiness
      without mutating SCM state.
- [ ] Evidence batch: connect status and diff summaries to capture plans.
- [ ] Validation batch: close the lane and select the next workflow checkpoint.

## Batch Cards

Ready cards:

- `batch-cards/181-git-capture-descriptor-policy.md`

Planned cards:

- `batch-cards/182-git-management-capture-plan-records.md`
- `batch-cards/183-git-capture-command-envelope-dry-run.md`
- `batch-cards/184-git-capture-status-and-diff-evidence.md`
- `batch-cards/185-git-capture-validation-and-next-lane.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] Git capture behavior is represented as adapter mapping, not universal SCM
      vocabulary.
- [ ] Git capture plans can be inspected without committing or pushing.
- [ ] Evidence links remain traceable to neutral capture records.
- [ ] The next lane is selected from the long-term plan.

## Gate

Do not execute Git commit, push, branch mutation, or review-request behavior in
this lane.
