# 025 Diagnostics Control DTO Serialization

Status: active
Owner: Tom
Updated: 2026-06-18

## Purpose

Serialize diagnostics query results through the existing control envelope DTO
boundary.

## Governing Refs

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [ ] Add transport-safe diagnostics response DTOs.
- [ ] Add response envelope serialization for diagnostics query results.
- [ ] Keep DTOs separate from durable authority records.
- [ ] Preserve raw-output and provider-payload exclusions.

## Execution Plan

- [ ] DTO record batch: expose diagnostics read models in control DTO modules.
- [ ] Response serialization batch: map diagnostics result variants to DTOs.
- [ ] Tauri IPC boundary batch: keep IPC as transport-only.
- [ ] Authority guard batch: prove DTOs cannot mutate.
- [ ] Validation batch: run focused serialization and docs gates.

## Batch Cards

Ready cards:

- `batch-cards/104-diagnostics-control-dto-record-shapes.md`

Planned cards:

- `batch-cards/105-response-envelope-diagnostics-serialization.md`
- `batch-cards/106-tauri-ipc-diagnostics-boundary.md`
- `batch-cards/107-diagnostics-dto-authority-guard-tests.md`
- `batch-cards/108-diagnostics-dto-validation.md`

## Acceptance Criteria

- [ ] Diagnostics query results serialize through control response envelopes.
- [ ] DTOs do not expose raw command output or provider payloads.
- [ ] Tauri IPC remains a transport boundary.

## Gate

Do not let DTO shapes become server storage records.
