# 025 Diagnostics Control DTO Serialization

Status: completed
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

- [x] Add transport-safe diagnostics response DTOs.
- [x] Add response envelope serialization for diagnostics query results.
- [x] Keep DTOs separate from durable authority records.
- [x] Preserve raw-output and provider-payload exclusions.

## Execution Plan

- [x] DTO record batch: expose diagnostics read models in control DTO modules.
- [x] Response serialization batch: map diagnostics result variants to DTOs.
- [x] Tauri IPC boundary batch: keep IPC as transport-only.
- [x] Authority guard batch: prove DTOs cannot mutate.
- [x] Validation batch: run focused serialization and docs gates.

## Batch Cards

Completed cards:

- `batch-cards/104-diagnostics-control-dto-record-shapes.md`
- `batch-cards/105-response-envelope-diagnostics-serialization.md`
- `batch-cards/106-tauri-ipc-diagnostics-boundary.md`
- `batch-cards/107-diagnostics-dto-authority-guard-tests.md`
- `batch-cards/108-diagnostics-dto-validation.md`

## Acceptance Criteria

- [x] Diagnostics query results serialize through control response envelopes.
- [x] DTOs do not expose raw command output or provider payloads.
- [x] Tauri IPC remains a transport boundary.

## Outcome

Diagnostics queries now serialize through the control request/response envelope.
The response DTO exposes steward, Effigy, management sync, SCM session, and
combined diagnostics snapshots as read-only payloads. The Tauri IPC fixture
can carry diagnostics without owning diagnostics state.

## Gate

Do not let DTO shapes become server storage records.
