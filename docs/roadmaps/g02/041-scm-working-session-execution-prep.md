# 041 SCM Working Session Execution Prep

Status: completed
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

- [x] Define working-session execution policy and authority.
- [x] Model primary-tree temporary-branch session plans.
- [x] Model isolated-worktree session plans.
- [x] Model cleanup, repair, and blocked-state records.
- [x] Keep destructive checkout, merge, delete, and cleanup operations gated.

## Execution Plan

- [x] Policy batch: reset execution authority for working sessions.
- [x] Primary-tree batch: add plan records for shared-directory temporary
      branch workflows.
- [x] Isolated-worktree batch: add plan records for per-thread worktree
      workflows.
- [x] Cleanup batch: add cleanup and repair records for interrupted sessions.
- [x] Validation batch: close the lane and select the next workflow checkpoint.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/186-working-session-execution-policy-reset.md`
- `batch-cards/187-primary-tree-branch-session-plan-records.md`
- `batch-cards/188-isolated-worktree-session-plan-records.md`
- `batch-cards/189-working-session-cleanup-and-repair-records.md`
- `batch-cards/190-working-session-execution-validation-and-next-lane.md`

## Acceptance Criteria

- [x] Working-session execution plans are explicit and policy-gated.
- [x] Primary-tree and isolated-worktree modes are modeled separately.
- [x] Cleanup and repair paths are reviewable before mutation.
- [x] The next lane is selected from the long-term plan.

## Gate

Do not perform checkout, branch creation, worktree creation, merge, cleanup, or
deletion until command authority and rollback policy are proven.

## Result

The lane added working-session execution prep records with primary-tree and
isolated-location guard checks, cleanup policy review, blocked runtime
constraints, and cleanup/repair recovery records. All records keep provider
mutation disabled.

The next lane is `042-change-request-preparation-boundary.md`, focused on
provider-neutral change-request candidates and evidence packages without forge
network calls.
