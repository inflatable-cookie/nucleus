# 006 Checkpoint And Diff Foundation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Create the first checkpoint and diff model that can later support agent turns,
SCM workflows, reviews, revert flows, and publication.

## Governing Refs

- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/architecture-gap-index.md`

## Goals

- [x] Define checkpoint identity and ownership in code.
- [x] Define diff summary records without assuming Git-only commits.
- [x] Link checkpoints to tasks, commands, receipts, and future SCM refs.
- [x] Keep worktree mutation and PR/change-request creation out of scope.

## Execution Plan

- [x] Checkpoint vocabulary batch: add checkpoint ids, scopes, refs, and
  lifecycle states.
- [x] Diff summary batch: add provider-neutral diff summary shape.
- [x] Projection batch: expose checkpoint/diff summaries as read-only
  diagnostics.
- [x] Validation batch: prove checkpoint records do not require Git commit
  semantics.

## Acceptance Criteria

- [x] Checkpoint records can represent task/session/change boundaries.
- [x] Diff summaries are SCM-adapter neutral.
- [x] Git terminology is not baked into core checkpoint identity.
- [x] The milestone leaves SCM mutation for `008-scm-forge-driver-runway.md`.

## Gate

Do not start until runtime receipt and task timeline provenance are strong
enough to link checkpoints to work evidence.

## Outcome

Completed the first checkpoint and diff foundation.

Implemented:

- `nucleus-engine` checkpoint and diff summary record types with JSON codecs.
- `nucleus-server` checkpoint/diff state helpers using typed artifact metadata
  records.
- read-only control API query results and DTOs for checkpoint and diff
  summaries.
- focused tests proving checkpoint/diff records do not collide with runtime
  receipt reads.

Deferred:

- snapshot capture
- SCM mutation
- branch and worktree management
- publication or change-request creation
- raw patch transport
