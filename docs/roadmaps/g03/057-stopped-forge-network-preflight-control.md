# 057 Stopped Forge Network Preflight Control

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Implement stopped forge network execution preflight and read-only control
records from provider-auth admissions.

This lane proves provider context refs, target provider refs, credential-use
evidence refs, preflight evidence refs, and planned provider-response evidence
refs without resolving credentials or calling forge networks.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/056-stopped-provider-auth-forge-admission-records.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add stopped preflight records from provider-auth admissions.
- [x] Add read-only control DTO counts for stopped preflight state.
- [x] Require provider context, target provider, credential-use evidence,
  preflight evidence, and planned provider-response evidence refs.
- [x] Keep credential resolution, provider network calls, callbacks, recovery,
  task mutation, and raw provider payload retention blocked.
- [x] Keep module files below warning pressure.

## Execution Plan

- [x] Preflight type surface.
- [x] Preflight record builder.
- [x] Control DTO.
- [x] Focused tests.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/199-forge-network-preflight-type-surface.md`
- `batch-cards/200-forge-network-preflight-record-builder.md`
- `batch-cards/201-forge-network-preflight-control-dto.md`
- `batch-cards/202-forge-network-preflight-blocker-tests.md`
- `batch-cards/203-forge-network-preflight-validation-closeout.md`

## Acceptance Criteria

- [x] Ready admissions can produce stopped execution-request preflight records.
- [x] Missing provider context, target provider, credential-use evidence,
  preflight evidence, provider-response evidence, network authority, operator
  approval, idempotency, retry, recovery, or sanitization refs block preflight.
- [x] Non-ready admissions and deferred operation families block preflight.
- [x] Real credential resolution, provider network calls, callbacks,
  interruption, recovery execution, task mutation, and raw provider payload
  retention are blocked.
- [x] Control DTO serializes sanitized counts only.
- [x] Focused tests pass.

## Closeout

`nucleus-server` now exposes `provider_forge_network_execution_preflight`.

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

- implement stopped forge network execution request/receipt records from
  preflight state before any live provider call
