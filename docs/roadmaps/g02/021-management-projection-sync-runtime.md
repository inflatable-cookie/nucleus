# 021 Management Projection Sync Runtime

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Connect management projection import/export, conflict reports, and steward
sync assistance into a policy-gated runtime flow.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [x] Add projection sync plan records.
- [x] Add import staging and repair proposal flow.
- [x] Add management capture preparation records from accepted sync assistance.
- [x] Keep provider-specific capture execution out of scope until SCM adapters
  are ready.

## Execution Plan

- [x] Sync plan batch: represent export/import/sync planning as engine records.
- [x] Import repair batch: route invalid or unsupported projection records into
  steward proposals.
- [x] Conflict proposal batch: convert projection conflict reports into
  mechanical or semantic assistance.
- [x] Capture prep batch: create management capture preparation records without
  provider mutation.
- [x] Validation batch: prove projection sync runtime does not silently
  overwrite task state.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/084-management-sync-plan-records.md`
- `batch-cards/085-projection-import-repair-proposals.md`
- `batch-cards/086-projection-conflict-assistance-routing.md`
- `batch-cards/087-management-capture-prep-records.md`
- `batch-cards/088-management-sync-runtime-validation.md`

## Acceptance Criteria

- [x] Projection sync work has a durable plan record.
- [x] Mechanical and semantic conflicts route differently.
- [x] Capture preparation remains separate from SCM provider mutation.
- [x] Import cannot silently overwrite local task meaning.

## Gate

Do not create commits, snapshots, publications, pushes, or provider authority
records here.
