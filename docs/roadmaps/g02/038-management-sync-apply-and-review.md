# 038 Management Sync Apply And Review

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Move repo-backed management sync from export/import staging into an explicit,
reviewable apply loop.

This lane applies validated project and task projection records into the active
server working set. It does not commit, publish, push, promote, merge, open
review requests, or run provider-specific SCM authority transitions.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/long-term-plan.md`

## Goals

- [x] Define apply authority for staged management projection records.
- [x] Add a command/service boundary for applying validated project and task
      projection records.
- [x] Enforce revision, conflict, and unsupported-schema gates before state
      changes.
- [x] Record receipts and audit evidence for applied management projection
      changes.
- [x] Expose review-ready sync state for clients or steward assistance without
      making clients authoritative.

## Execution Plan

- [x] Policy batch: promote import-apply authority, revision expectations, and
      no-silent-overwrite rules into canonical contracts.
- [x] Apply batch: add a bounded import-apply command path for staged project
      and task projection records.
- [x] Conflict batch: prove expected-revision and semantic-conflict gates with
      fixtures.
- [x] Receipt batch: persist sanitized apply receipts and timeline evidence.
- [x] Review batch: expose review/apply/conflict read models without adding UI
      polish or SCM capture behavior.
- [x] Validation batch: close the lane and select the next workflow checkpoint.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/169-management-projection-apply-policy-contract.md`
- `batch-cards/170-management-projection-import-apply-command.md`
- `batch-cards/171-management-projection-revision-conflict-gates.md`
- `batch-cards/172-management-projection-apply-receipts-and-audit.md`
- `batch-cards/173-management-sync-review-read-model.md`
- `batch-cards/174-management-sync-apply-validation-and-next-lane.md`

## Acceptance Criteria

- [x] Valid staged project/task projection records can be applied only through
      an admitted command boundary.
- [x] Invalid, unsupported, stale, or semantically conflicting records do not
      mutate active state.
- [x] Apply operations record sanitized receipts and preserve staged evidence.
- [x] SCM capture/publish work remains outside this lane.
- [x] The next lane is selected from the long-term plan rather than invented
      from the final card.

## Gate

Do not build steward automatic sync, SCM capture/publish, or desktop sync
controls until apply authority, conflict review, and receipts are proven.

## Result

The lane proved explicit import-apply command authority for validated
project/task projection records, expected-revision and no-silent-overwrite
gates, sanitized apply receipts, and a review read model for staged, applied,
blocked, conflict, repair, and receipt state.

The next lane is `039-scm-management-capture-and-share-foundation.md`, focused
on provider-neutral capture/share preparation before SCM mutation,
publish/promote behavior, forge review requests, steward automation, or UI sync
controls expand.
