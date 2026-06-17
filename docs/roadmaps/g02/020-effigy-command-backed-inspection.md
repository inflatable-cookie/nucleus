# 020 Effigy Command-Backed Inspection

Status: active
Owner: Tom
Updated: 2026-06-18

## Purpose

Move Effigy integration from record-only descriptors to read-only,
command-backed inspection.

This milestone should execute only after the native steward command boundary is
stable.

## Governing Refs

- `docs/contracts/016-effigy-project-integration-contract.md`
- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/018-orchestration-contract.md`

## Goals

- [x] Add command-backed Effigy selector inventory refresh.
- [x] Add command-backed Effigy health summary capture.
- [x] Add command-backed `effigy test --plan` summary capture.
- [ ] Keep raw command output out of durable task history.

## Execution Plan

- [x] Selector refresh batch: map `effigy tasks` evidence into selector records.
- [x] Doctor summary batch: map doctor evidence into health summaries.
- [x] Test-plan batch: map `effigy test --plan` evidence into validation plan
  summaries.
- [ ] Repair hint batch: turn missing selector/manifest evidence into steward
  repair hints.
- [ ] Validation batch: prove all Effigy evidence is summarized or referenced,
  not copied raw.

## Batch Cards

Ready cards:

- `batch-cards/082-effigy-repair-hint-synthesis.md`

Planned cards:

- `batch-cards/083-effigy-command-inspection-validation.md`

Completed cards:

- `batch-cards/079-effigy-selector-refresh-command.md`
- `batch-cards/080-effigy-doctor-summary-command.md`
- `batch-cards/081-effigy-test-plan-summary-command.md`

## Acceptance Criteria

- [x] Effigy selector inventory can be refreshed through a read-only command
  path.
- [x] Doctor and validation-plan summaries link to command evidence and
  runtime receipts.
- [ ] Raw Effigy output remains excluded from task history, memory, and
  projected management files.

## Gate

Do not add Effigy manifest editing or selector execution in this milestone.
