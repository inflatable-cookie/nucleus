# 017 SCM Working Copy And Change Request Workflows

Status: planned-after-016
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

- [ ] Implement a Git driver through neutral SCM capabilities.
- [ ] Support primary-tree temporary branch sessions.
- [ ] Support isolated worktree sessions.
- [ ] Prepare change-request handoff records without hard-coding GitHub into
  SCM storage semantics.
- [ ] Keep Convergence terminology viable for later adapter work.

## Execution Plan

- [ ] Git driver batch: inspect status and refs through adapter records.
- [ ] Working-copy session batch: model primary-tree and isolated worktree
  modes.
- [ ] Checkpoint/diff batch: tie captured changes to work items and receipts.
- [ ] Change-request prep batch: stage forge handoff records.

## Acceptance Criteria

- [ ] Nucleus can distinguish primary-tree and isolated worktree workflows.
- [ ] Dirty state, branch/session refs, and cleanup policy are explicit.
- [ ] Git implementation does not leak commit-only terminology into neutral
  SCM records.
- [ ] Change-request preparation is separated from forge publication.

## Gate

Do not mutate shared branches or publish change requests until authority,
credential, and recovery policy are explicit.
