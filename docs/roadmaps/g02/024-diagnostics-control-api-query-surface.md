# 024 Diagnostics Control API Query Surface

Status: active
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

- [ ] Add diagnostics query kinds to the control API.
- [ ] Add diagnostics result variants.
- [ ] Route diagnostics queries through the local request handler.
- [ ] Keep diagnostics read-only and source-safe.

## Execution Plan

- [ ] Query vocabulary batch: name diagnostics query kinds.
- [ ] Result variant batch: return typed diagnostics read models.
- [ ] Handler routing batch: wire local handler query execution.
- [ ] Fixture batch: prove empty and populated diagnostics responses.
- [ ] Validation batch: prove diagnostics queries do not mutate state.

## Batch Cards

Ready cards:

- `batch-cards/099-control-api-diagnostics-query-kinds.md`

Planned cards:

- `batch-cards/100-server-query-result-diagnostics-variants.md`
- `batch-cards/101-request-handler-diagnostics-query-routing.md`
- `batch-cards/102-diagnostics-query-fixture-tests.md`
- `batch-cards/103-diagnostics-query-validation.md`

## Acceptance Criteria

- [ ] Clients can request steward, Effigy, sync, and SCM diagnostics.
- [ ] Diagnostics responses remain server-owned read models.
- [ ] Unsupported or empty diagnostics are explicit.

## Gate

Do not add mutation commands or UI authority in this milestone.
