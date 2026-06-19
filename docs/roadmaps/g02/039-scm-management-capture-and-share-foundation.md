# 039 SCM Management Capture And Share Foundation

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Move from local management projection apply/review to provider-neutral
capture/share preparation for accepted management projection changes.

This lane does not implement Git commit, push, publish, promote, merge,
Convergence publication, forge review requests, or provider-specific SCM
mutation. It defines the safe command boundary, record shape, evidence linkage,
and review state needed before those actions are allowed.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/long-term-plan.md`
- `docs/roadmaps/g02/038-management-sync-apply-and-review.md`

## Goals

- [x] Define capture/share authority after local management projection
      apply/review succeeds.
- [x] Add management capture request and admission record shapes without
      provider execution.
- [x] Link capture preparation to projection file refs, apply receipts, and
      review state.
- [x] Prove Git-neutral and Convergence-neutral vocabulary in fixtures.
- [x] Keep publish, push, promote, merge, and review-request behavior gated
      behind later adapter-specific work.

## Execution Plan

- [x] Policy batch: clarify provider-neutral capture/share terms and keep SCM
      mutation outside the current lane.
- [x] Command-record batch: add management capture command/prep records without
      running provider commands.
- [x] Evidence-linkage batch: connect capture prep to projection refs, apply
      receipts, and review summaries.
- [x] Neutrality batch: add fixtures and tests proving Git-only commit/push
      assumptions do not leak into core records.
- [x] Review-model batch: expose capture/share gate state to clients without
      making clients authoritative.
- [x] Validation batch: close the lane and select the next workflow checkpoint.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/175-scm-management-capture-policy-reset.md`
- `batch-cards/176-management-capture-command-records.md`
- `batch-cards/177-management-capture-receipt-linkage.md`
- `batch-cards/178-provider-neutral-share-gate-fixtures.md`
- `batch-cards/179-management-capture-review-read-model.md`
- `batch-cards/180-scm-management-capture-validation-and-next-lane.md`

## Acceptance Criteria

- [x] A command boundary exists for preparing management projection capture.
- [x] Records use provider-neutral capture/share terminology, not Git-only
      commit/push vocabulary.
- [x] Capture preparation is separated from provider-specific share, publish,
      promote, merge, and review-request operations.
- [x] Capture evidence links to projection file refs, apply receipts, and
      review state.
- [x] The next lane is selected from the long-term plan rather than invented
      from the final card.

## Gate

Do not implement provider SCM mutation, forge review requests, steward
automatic sync, or desktop sync polish until capture/share preparation records
are provider-neutral and linked to reviewable evidence.

## Result

The lane added provider-neutral management capture command/admission records,
evidence-linked capture prep records, Git-like and Convergence-like neutrality
fixtures, and a client-safe management capture review read model.

The next lane is `040-git-management-capture-adapter-proof.md`, focused on
mapping neutral capture prep to Git-specific dry-run planning and sanitized
status/diff evidence without committing, pushing, or mutating refs.
