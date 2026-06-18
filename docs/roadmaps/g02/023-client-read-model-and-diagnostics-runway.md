# 023 Client Read Model And Diagnostics Runway

Status: active
Owner: Tom
Updated: 2026-06-18

## Purpose

Expose the new command, receipt, projection, steward, Effigy, and SCM state as
client-readable diagnostics before UI design hardens.

## Governing Refs

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/012-native-harness-runtime-contract.md`

## Goals

- [ ] Add read models for steward command/proposal state.
- [ ] Add read models for Effigy integration and health state.
- [ ] Add read models for projection sync and SCM session state.
- [ ] Keep the current UI disposable and server-first.

## Execution Plan

- [ ] Steward diagnostics batch: expose steward proposals, command status, and
  approval state.
- [ ] Effigy diagnostics batch: expose selector inventory, health summary, and
  validation-plan state.
- [ ] Sync diagnostics batch: expose management projection sync plans and
  conflict assistance.
- [ ] SCM diagnostics batch: expose working-session planning and task linkage.
- [ ] Client DTO validation batch: prove read models serialize through the
  server boundary without UI authority drift.

## Batch Cards

Ready cards:

- `batch-cards/094-steward-diagnostics-read-model.md`

Planned cards:

- `batch-cards/095-effigy-diagnostics-read-model.md`
- `batch-cards/096-sync-diagnostics-read-model.md`
- `batch-cards/097-scm-session-diagnostics-read-model.md`
- `batch-cards/098-client-diagnostics-dto-validation.md`

## Acceptance Criteria

- [ ] Clients can inspect steward, Effigy, sync, and SCM state without owning
  it.
- [ ] DTOs preserve authority boundaries.
- [ ] The desktop remains a disposable proof surface for server functions.

## Gate

Do not start serious UI design until these read models make the server state
inspectable.
