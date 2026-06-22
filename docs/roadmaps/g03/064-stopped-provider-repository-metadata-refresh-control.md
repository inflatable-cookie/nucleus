# 064 Stopped Provider Repository Metadata Refresh Control

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Implement stopped provider repository metadata refresh/control records from
provider context refs.

This lane records planned repository metadata refresh state without resolving
credential material, calling provider networks, retaining provider payloads, or
mutating tasks.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/063-provider-auth-stopped-boundary-health-rebaseline.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add stopped repository metadata refresh records from provider context
  refs.
- [x] Require provider instance, forge provider, remote repo,
  credential-status evidence, repository-metadata evidence, and sanitization
  policy refs.
- [x] Block credential material, provider payloads, real credential
  resolution, provider network calls, callbacks, interruption, recovery
  execution, task mutation, and raw provider payload retention.
- [x] Expose read-only control DTO counts.
- [x] Keep module files below warning pressure.

## Execution Plan

- [x] Repository metadata refresh type surface.
- [x] Repository metadata refresh record builder.
- [x] Repository metadata refresh control DTO.
- [x] Blocker tests.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/234-provider-repository-metadata-refresh-type-surface.md`
- `batch-cards/235-provider-repository-metadata-refresh-record-builder.md`
- `batch-cards/236-provider-repository-metadata-refresh-control-dto.md`
- `batch-cards/237-provider-repository-metadata-refresh-blocker-tests.md`
- `batch-cards/238-provider-repository-metadata-refresh-validation-closeout.md`

## Acceptance Criteria

- [x] Provider context refs can produce stopped repository metadata refresh
  records.
- [x] Missing required refs produce repair-required records.
- [x] Credential material, provider payloads, raw payload retention, real
  credential resolution, provider network calls, callbacks, interruption,
  recovery execution, and task mutation are blocked.
- [x] Control DTO serializes sanitized counts only.
- [x] Focused tests pass.

## Closeout

`nucleus-server` now exposes `provider_forge_repository_metadata_refresh`.

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

- persist stopped provider repository metadata refresh records before any live
  credential resolution or provider network call
