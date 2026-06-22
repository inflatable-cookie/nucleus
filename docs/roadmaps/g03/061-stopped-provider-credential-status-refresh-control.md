# 061 Stopped Provider Credential Status Refresh Control

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Implement stopped provider credential-status refresh/control records from
credential refs.

This lane records planned provider auth status refresh state without resolving
credential material, calling provider networks, retaining provider payloads, or
mutating tasks.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/060-forge-network-stopped-runner-health-boundary-rebaseline.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add stopped credential-status refresh records from credential refs.
- [x] Classify credential status into ready, repair, unknown, and unsupported
  control buckets.
- [x] Require provider context, status refresh evidence, and sanitization
  policy refs.
- [x] Block credential material, provider payloads, real credential
  resolution, provider network calls, callbacks, interruption, recovery
  execution, task mutation, and raw provider payload retention.
- [x] Expose read-only control DTO counts.
- [x] Keep module files below warning pressure.

## Execution Plan

- [x] Credential-status refresh type surface.
- [x] Credential-status refresh record builder.
- [x] Credential-status refresh control DTO.
- [x] Blocker and classification tests.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/219-provider-credential-status-refresh-type-surface.md`
- `batch-cards/220-provider-credential-status-refresh-record-builder.md`
- `batch-cards/221-provider-credential-status-refresh-control-dto.md`
- `batch-cards/222-provider-credential-status-refresh-blocker-tests.md`
- `batch-cards/223-provider-credential-status-refresh-validation-closeout.md`

## Acceptance Criteria

- [x] Credential refs can produce stopped status-refresh records.
- [x] Ready, repair, unknown, and unsupported credential classes are counted.
- [x] Missing provider context, status evidence, or sanitization refs produce
  repair-required records.
- [x] Credential material, provider payloads, raw payload retention, real
  credential resolution, provider network calls, callbacks, interruption,
  recovery execution, and task mutation are blocked.
- [x] Control DTO serializes sanitized counts only.
- [x] Focused tests pass.

## Closeout

`nucleus-server` now exposes `provider_forge_credential_status_refresh`.

The module is split into:

- front-door module
- `types`
- `record_builder`
- focused tests

It remains stopped by default:

- no credential material is resolved
- no provider network calls are made
- no provider effects are executed
- no callbacks, interruption, recovery execution, task mutation, or raw
  provider payload retention are granted

Next lane:

- persist stopped provider credential-status refresh records before any live
  credential resolution or provider network call
