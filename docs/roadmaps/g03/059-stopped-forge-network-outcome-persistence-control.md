# 059 Stopped Forge Network Outcome Persistence Control

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Persist sanitized stopped forge network execution outcomes from request and
receipt records, then expose read-only diagnostics and control DTOs.

This lane records provider outcome status without resolving credentials,
calling forge networks, retaining raw provider payloads, or executing recovery.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/058-stopped-forge-network-request-receipt.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add sanitized outcome persistence records from stopped request receipts.
- [x] Preserve request, receipt, preflight, admission, task, repo, operator,
  provider, credential-ref, idempotency, retry, recovery, runtime receipt, and
  evidence refs.
- [x] Detect duplicate outcome ids as deterministic no-op records.
- [x] Block raw request/response bodies, headers, credential material,
  provider payloads, real credential resolution, provider network calls,
  callbacks, interruption, recovery execution, task mutation, and raw payload
  retention.
- [x] Expose read-only diagnostics and control DTOs with sanitized counts.
- [x] Keep module files below warning pressure.

## Execution Plan

- [x] Outcome persistence type surface.
- [x] Outcome persistence store.
- [x] Outcome diagnostics and control DTO.
- [x] Blocker and duplicate tests.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/209-forge-network-outcome-persistence-type-surface.md`
- `batch-cards/210-forge-network-outcome-persistence-store.md`
- `batch-cards/211-forge-network-outcome-diagnostics-control.md`
- `batch-cards/212-forge-network-outcome-blocker-tests.md`
- `batch-cards/213-forge-network-outcome-validation-closeout.md`

## Acceptance Criteria

- [x] Stopped request receipts can produce sanitized persisted outcome records.
- [x] Persisted records round-trip through local artifact metadata.
- [x] Duplicate outcome ids become no-op records and do not rewrite storage.
- [x] Blocked and repair-required request receipts stay inspectable.
- [x] Missing evidence refs and raw/provider/effect requests block
  persistence.
- [x] Diagnostics and control DTOs expose sanitized counts only.
- [x] Focused tests pass.

## Closeout

`nucleus-server` now exposes
`provider_forge_network_execution_outcome_persistence`.

The module is split into:

- front-door module
- `types`
- `record_builder`
- `store`
- `diagnostics`
- focused tests and support fixtures

It remains stopped by default:

- no credential material is resolved
- no provider network calls are made
- no forge effects are executed
- no callbacks, interruption, recovery execution, task mutation, or raw
  provider payload retention are granted

Next lane:

- run a forge network stopped-runner health and boundary rebaseline before any
  real credential resolution or provider network call
