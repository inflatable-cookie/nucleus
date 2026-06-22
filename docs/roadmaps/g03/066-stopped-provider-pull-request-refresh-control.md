# 066 Stopped Provider Pull-Request Refresh Control

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Implement stopped provider pull-request/merge-request refresh control records
from provider context and repository metadata refs.

This lane records planned pull-request or merge-request refresh state without
resolving credential material, calling provider networks, retaining provider
payloads, or mutating tasks.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/065-stopped-provider-repository-metadata-refresh-persistence.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add stopped pull-request/merge-request refresh records from provider
  context refs.
- [x] Require provider instance, forge provider, remote repo, refresh scope,
  credential-status evidence, repository-metadata evidence,
  pull-request-refresh evidence, and sanitization policy refs.
- [x] Support all-open and specific change-request refresh scopes.
- [x] Block credential material, provider payloads, raw payload retention, real
  credential resolution, provider network calls, callbacks, interruption,
  recovery execution, and task mutation.
- [x] Expose read-only control DTO counts.
- [x] Keep module files below warning pressure.

## Execution Plan

- [x] Pull-request refresh type surface.
- [x] Pull-request refresh record builder.
- [x] Pull-request refresh control DTO.
- [x] Blocker tests.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/244-provider-pull-request-refresh-type-surface.md`
- `batch-cards/245-provider-pull-request-refresh-record-builder.md`
- `batch-cards/246-provider-pull-request-refresh-control-dto.md`
- `batch-cards/247-provider-pull-request-refresh-blocker-tests.md`
- `batch-cards/248-provider-pull-request-refresh-validation-closeout.md`

## Acceptance Criteria

- [x] Provider context refs can produce stopped pull-request/merge-request
  refresh records.
- [x] Missing required refs and invalid scoped change-request refs produce
  repair-required records.
- [x] Credential material, provider payloads, raw payload retention, real
  credential resolution, provider network calls, callbacks, interruption,
  recovery execution, and task mutation are blocked.
- [x] Control DTO serializes sanitized counts only.
- [x] Focused tests pass.

## Closeout

`nucleus-server` now exposes `provider_forge_pull_request_refresh`.

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

- persist stopped provider pull-request/merge-request refresh records before
  any live credential resolution or provider network call
