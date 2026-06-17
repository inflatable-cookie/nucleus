# 017 SCM Working Copy And Change Request Workflows

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Implement the first SCM workflow layer after neutral driver capabilities,
checkpoint/diff records, and management projection files are ready.

This milestone should support Git branch/worktree workflows without making Git
the universal SCM model.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/research/translation-memos/convergence-scm-shape.md`
- `docs/roadmaps/g02/008-scm-forge-driver-runway.md`

## Goals

- [x] Implement a Git driver through neutral SCM capabilities.
- [x] Support primary-tree temporary branch sessions.
- [x] Support isolated worktree sessions.
- [x] Prepare change-request handoff records without hard-coding GitHub into
  SCM storage semantics.
- [x] Keep Convergence terminology viable for later adapter work.

## Execution Plan

- [x] Git driver batch: inspect status and refs through adapter records.
- [x] Working-copy session batch: model primary-tree and isolated worktree
  modes.
- [x] Checkpoint/diff batch: tie captured changes to work items and receipts.
- [x] Change-request prep batch: stage forge handoff records.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/062-git-driver-status-and-ref-inspection.md`
- `batch-cards/063-working-copy-session-modes.md`
- `batch-cards/064-scm-checkpoint-diff-work-item-linkage.md`
- `batch-cards/065-change-request-prep-records.md`

## Acceptance Criteria

- [x] Nucleus can distinguish primary-tree and isolated worktree workflows.
- [x] Dirty state, branch/session refs, and cleanup policy are explicit.
- [x] Git implementation does not leak commit-only terminology into neutral
  SCM records.
- [x] Change-request preparation is separated from forge publication.

## Gate

Do not mutate shared branches or publish change requests until authority,
credential, and recovery policy are explicit.
