# 018 Steward Native Harness And Effigy Tools

Status: planned
Owner: Tom
Updated: 2026-06-17

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
- `docs/contracts/016-effigy-integration-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [ ] Define steward persona authority and action limits.
- [ ] Add Effigy task discovery, health summary, and validation planning tools.
- [ ] Add task-organization proposals with review before mutation.
- [ ] Add management projection sync assistance.
- [ ] Prepare local/small-model backend hooks without committing to one model
  provider.

## Execution Plan

- [ ] Steward authority batch: map allowed commands and receipts.
- [ ] Effigy tools batch: expose selectors, doctor summaries, and test plans.
- [ ] Task hygiene batch: propose task edits and project organization changes.
- [ ] Sync assistance batch: assist projection conflict resolution and SCM sync.

## Acceptance Criteria

- [ ] Steward actions are command-backed and receipt-backed.
- [ ] Effigy integration can explain available tasks and validation plans.
- [ ] Steward may propose project-management changes without silent mutation.
- [ ] Local model backend remains adapter-bound and optional.

## Gate

Do not grant autonomous mutation authority until steward proposals, review,
receipts, and rollback/recovery behavior are proven.

