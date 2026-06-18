# 024 Diagnostics Control API Query Surface

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Make steward, Effigy, sync, and SCM diagnostics reachable through the
transport-neutral control API.

The diagnostics DTO records exist. This milestone wires them into query
vocabulary and request-handler routing without granting mutation authority.

## Governing Refs

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/012-native-harness-runtime-contract.md`

## Goals

- [x] Add diagnostics query kinds to the control API.
- [x] Add diagnostics result variants.
- [x] Route diagnostics queries through the local request handler.
- [x] Keep diagnostics read-only and source-safe.

## Execution Plan

- [x] Query vocabulary batch: name diagnostics query kinds.
- [x] Result variant batch: return typed diagnostics read models.
- [x] Handler routing batch: wire local handler query execution.
- [x] Fixture batch: prove empty and populated diagnostics responses.
- [x] Validation batch: prove diagnostics queries do not mutate state.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/099-control-api-diagnostics-query-kinds.md`
- `batch-cards/100-server-query-result-diagnostics-variants.md`
- `batch-cards/101-request-handler-diagnostics-query-routing.md`
- `batch-cards/102-diagnostics-query-fixture-tests.md`
- `batch-cards/103-diagnostics-query-validation.md`

## Acceptance Criteria

- [x] Clients can request steward, Effigy, sync, and SCM diagnostics.
- [x] Diagnostics responses remain server-owned read models.
- [x] Unsupported or empty diagnostics are explicit.

## Gate

Do not add mutation commands or UI authority in this milestone.
