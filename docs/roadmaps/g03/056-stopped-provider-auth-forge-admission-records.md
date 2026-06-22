# 056 Stopped Provider Auth Forge Admission Records

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Implement stopped provider-auth and forge network-execution admission records
from contract `027`.

This lane proves the first server-owned record shape for provider credential
refs, network-authority refs, mutating-effect approval refs, idempotency keys,
retry/recovery policy refs, and sanitization policy refs without resolving real
credentials or calling forge networks.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/055-provider-auth-forge-execution-contract-lane.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add stopped forge network execution admission records.
- [x] Represent credential refs and credential status without credential
  material.
- [x] Represent network authority, operator approval, idempotency,
  retry/recovery, and sanitization refs.
- [x] Block deferred mutating effects and real provider execution.
- [x] Keep the module split below warning pressure.

## Execution Plan

- [x] Admission type surface.
- [x] Admission record builder.
- [x] Blocker/status tests.
- [x] Export wiring.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/194-provider-auth-admission-type-surface.md`
- `batch-cards/195-forge-network-admission-record-builder.md`
- `batch-cards/196-forge-network-admission-blocker-tests.md`
- `batch-cards/197-forge-network-admission-export-wiring.md`
- `batch-cards/198-forge-network-admission-validation-closeout.md`

## Acceptance Criteria

- [x] Admission records can be ready for stopped preflight.
- [x] Missing credential, network, approval, idempotency, retry, recovery, or
  sanitization refs block admission.
- [x] Deferred operation families block admission.
- [x] Real credential resolution, provider network calls, callbacks,
  interruption, recovery execution, task mutation, and raw provider payload
  retention are blocked.
- [x] Serialized records contain credential refs, not credential material.
- [x] Focused tests pass.

## Closeout

`nucleus-server` now exposes `provider_forge_network_execution_admission`.

The module is split into:

- front-door module
- `types`
- `record_builder`
- focused tests

It remains stopped by default:

- no credential material is resolved
- no provider network calls are made
- no forge effects are executed
- no callbacks, interruption, recovery execution, task mutation, or raw
  provider payload retention are granted

Next lane:

- implement stopped forge network execution preflight/control records from
  these admissions before any credential resolution or provider network call
