# 008 SCM Forge Driver Runway

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Prepare the adapter-based SCM and forge runtime without assuming Git is the
only source-control model.

This milestone should create the driver registry and capability vocabulary
that can represent Git, Convergence, and future SCMs before implementing
workflow-heavy branch/worktree/change-request behavior.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/architecture/architecture-gap-index.md`
- `../convergence` as local reference only when inspecting Convergence shape

## Goals

- [x] Split SCM driver capabilities from forge provider capabilities.
- [x] Define neutral terms for commits, snapshots, publications, change
  requests, reviews, merges, and repair flows.
- [x] Add a Git driver runway without making Git semantics universal.
- [x] Add a Convergence shape note before locking capability names.
- [x] Defer real branch/worktree mutation until the driver boundary is proven.

## Execution Plan

- [x] Research refresh batch: inspect `../convergence` and current SCM contract
  for terminology risks.
- [x] Capability batch: define SCM and forge capability records.
- [x] Registry batch: add first Rust registry traits and fixture drivers.
- [x] Workflow gate batch: compile the later branch/worktree/change-request
  milestone from proven capability terms.

## Ready Cards

- `batch-cards/025-convergence-shape-and-vocabulary-risk-pass.md`
- `batch-cards/026-scm-forge-capability-neutralization.md`
- `batch-cards/027-driver-registry-and-fixture-surfaces.md` - completed
- `batch-cards/028-workflow-gate-and-follow-on-runway.md` - completed

## Acceptance Criteria

- [x] Core SCM vocabulary does not assume a Git commit is the universal unit.
- [x] Git and Convergence can both be described by adapter capabilities.
- [x] Forge provider concepts are separate from SCM storage concepts.
- [x] Later branch/worktree implementation has a clear ready gate.

## Gate

Do not start until management projections and checkpoint/diff records define
what SCM workflows will publish or review.

## Outcome

Completed the first SCM/forge driver runway.

The implementation now has:

- Convergence vocabulary evidence in
  `docs/research/translation-memos/convergence-scm-shape.md`
- neutral SCM capability names for capture, sharing, review boundaries,
  working-copy sessions, and integration
- distinct Git-like and Convergence-like SCM capability profiles
- metadata-only SCM and forge driver descriptors
- a metadata-only registry that lists SCM and forge drivers separately

The runway deliberately stops before branch, worktree, publication, review, or
merge mutation.

## Mutation Ready Gate

Do not implement SCM or forge mutation until all of these exist:

- management projection export and import plan for the affected records
- checkpoint and diff refs for the work being captured or reviewed
- driver descriptor proving provider capabilities and workflow semantics
- host authority map proving which host owns file, SCM, network, and credential
  authority
- command/effect receipt records for attempted provider actions
- policy scope for destructive, shared-authority, and credential-backed actions
- recovery rule for abandoned, failed, or partially shared work

## Follow-On Runways

Git branch and worktree work should be its own implementation milestone. It
should cover primary working-copy sessions, isolated working-copy sessions,
branch refs, dirty-state admission, integration, review-request handoff, and
cleanup policy.

Convergence work should be a separate implementation milestone. It should
cover snap capture, publication targets, gates, scopes, bundles, promotion, and
release refs without translating everything into Git commits.

Forge change-request work should be separate from SCM capture work. It should
cover pull requests, merge requests, issues, comments, webhooks, polling,
review workflow records, and provider credential readiness.
