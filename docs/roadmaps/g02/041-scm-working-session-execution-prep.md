# 041 SCM Working Session Execution Prep

Status: active
Owner: Tom
Updated: 2026-06-19

## Purpose

Prepare policy-gated working-session execution records for primary-tree and
isolated-worktree workflows.

This lane keeps execution planning separate from provider mutation. It models
what must be true before Nucleus may switch a primary tree, create an isolated
worktree, clean up a session, or repair a broken session.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/017-scm-working-copy-and-change-request-workflows.md`
- `docs/roadmaps/g02/040-git-management-capture-adapter-proof.md`
- `docs/roadmaps/long-term-plan.md`

## Goals

- [ ] Define working-session execution policy and authority.
- [ ] Model primary-tree temporary-branch session plans.
- [ ] Model isolated-worktree session plans.
- [ ] Model cleanup, repair, and blocked-state records.
- [ ] Keep destructive checkout, merge, delete, and cleanup operations gated.

## Execution Plan

- [ ] Policy batch: reset execution authority for working sessions.
- [ ] Primary-tree batch: add plan records for shared-directory temporary
      branch workflows.
- [ ] Isolated-worktree batch: add plan records for per-thread worktree
      workflows.
- [ ] Cleanup batch: add cleanup and repair records for interrupted sessions.
- [ ] Validation batch: close the lane and select the next workflow checkpoint.

## Batch Cards

Ready cards:

- `batch-cards/186-working-session-execution-policy-reset.md`

Planned cards:

- `batch-cards/187-primary-tree-branch-session-plan-records.md`
- `batch-cards/188-isolated-worktree-session-plan-records.md`
- `batch-cards/189-working-session-cleanup-and-repair-records.md`
- `batch-cards/190-working-session-execution-validation-and-next-lane.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] Working-session execution plans are explicit and policy-gated.
- [ ] Primary-tree and isolated-worktree modes are modeled separately.
- [ ] Cleanup and repair paths are reviewable before mutation.
- [ ] The next lane is selected from the long-term plan.

## Gate

Do not perform checkout, branch creation, worktree creation, merge, cleanup, or
deletion until command authority and rollback policy are proven.
