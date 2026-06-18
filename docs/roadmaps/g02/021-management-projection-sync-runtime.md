# 021 Management Projection Sync Runtime

Status: active
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

- [ ] Add projection sync plan records.
- [ ] Add import staging and repair proposal flow.
- [ ] Add management capture preparation records from accepted sync assistance.
- [ ] Keep provider-specific capture execution out of scope until SCM adapters
  are ready.

## Execution Plan

- [ ] Sync plan batch: represent export/import/sync planning as engine records.
- [ ] Import repair batch: route invalid or unsupported projection records into
  steward proposals.
- [ ] Conflict proposal batch: convert projection conflict reports into
  mechanical or semantic assistance.
- [ ] Capture prep batch: create management capture preparation records without
  provider mutation.
- [ ] Validation batch: prove projection sync runtime does not silently
  overwrite task state.

## Batch Cards

Ready cards:

- `batch-cards/084-management-sync-plan-records.md`

Planned cards:

- `batch-cards/085-projection-import-repair-proposals.md`
- `batch-cards/086-projection-conflict-assistance-routing.md`
- `batch-cards/087-management-capture-prep-records.md`
- `batch-cards/088-management-sync-runtime-validation.md`

## Acceptance Criteria

- [ ] Projection sync work has a durable plan record.
- [ ] Mechanical and semantic conflicts route differently.
- [ ] Capture preparation remains separate from SCM provider mutation.
- [ ] Import cannot silently overwrite local task meaning.

## Gate

Do not create commits, snapshots, publications, pushes, or provider authority
records here.
