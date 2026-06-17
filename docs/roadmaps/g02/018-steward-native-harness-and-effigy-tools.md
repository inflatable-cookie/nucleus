# 018 Steward Native Harness And Effigy Tools

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Start the Nucleus-owned steward/native harness lane after the bridged runtime
and task-backed work-unit spine are proven.

The steward should manage project hygiene, task organization, Effigy workflows,
and controlled sync assistance without pretending to be a general provider
harness.

## Governing Refs

- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/015-deep-research-contract.md`
- `docs/contracts/016-effigy-project-integration-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [ ] Define steward persona authority and action limits.
- [x] Add Effigy task discovery, health summary, and validation planning tools.
- [x] Add task-organization proposals with review before mutation.
- [x] Add management projection sync assistance.
- [x] Prepare local/small-model backend hooks without committing to one model
  provider.

## Execution Plan

- [x] Steward authority batch: map allowed persona, tool, approval, audit, and
  receipt records.
- [x] Effigy tools batch: expose selector inventory, doctor summaries, and
  validation plans as evidence records.
- [x] Task hygiene batch: propose task edits and project organization changes
  without silent mutation.
- [x] Sync assistance batch: assist projection conflict resolution and SCM sync
  without creating commits or pushes.
- [x] Backend posture batch: keep local and cloud model backends swappable and
  authority-neutral.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/066-steward-persona-authority-records.md`
- `batch-cards/067-native-tool-action-and-receipt-linkage.md`
- `batch-cards/068-effigy-selector-inventory-records.md`
- `batch-cards/069-effigy-health-and-validation-plan-records.md`
- `batch-cards/070-task-hygiene-proposal-records.md`
- `batch-cards/071-steward-sync-assistance-records.md`
- `batch-cards/072-native-model-backend-posture-records.md`
- `batch-cards/073-steward-lane-validation-and-next-runway.md`

## Acceptance Criteria

- [x] Steward actions are command-backed and receipt-backed.
- [x] Effigy integration can explain available tasks and validation plans.
- [x] Steward may propose project-management changes without silent mutation.
- [x] Local model backend remains adapter-bound and optional.

## Gate

Do not grant autonomous mutation authority until steward proposals, review,
receipts, and rollback/recovery behavior are proven.

Do not start before the committable projection and SCM workflow lanes are
stable enough for the steward to assist with real project hygiene.
