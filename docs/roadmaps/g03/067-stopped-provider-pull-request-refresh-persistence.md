# 067 Stopped Provider Pull-Request Refresh Persistence

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Persist stopped provider pull-request/merge-request refresh records before any
live credential resolution or provider network call.

This lane stores sanitized PR/MR refresh records, duplicate no-ops, blocked
persistence records, diagnostics, and read-only control counts.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/066-stopped-provider-pull-request-refresh-control.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Persist stopped PR/MR refresh records through local artifact metadata.
- [x] Preserve provider context, provider instance, forge provider, remote repo,
  refresh scope, credential-status evidence, repository-metadata evidence,
  pull-request-refresh evidence, sanitization policy, and evidence refs.
- [x] Represent duplicate refresh ids as deterministic no-op records.
- [x] Block credential material, provider payloads, raw payload retention, real
  credential resolution, provider network calls, callbacks, interruption,
  recovery execution, and task mutation.
- [x] Expose diagnostics and read-only control DTO counts.
- [x] Keep module files below warning pressure.

## Execution Plan

- [x] PR/MR refresh persistence type surface.
- [x] PR/MR refresh persistence store.
- [x] PR/MR refresh persistence diagnostics/control.
- [x] Blocker, duplicate, and round-trip tests.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/249-provider-pull-request-refresh-persistence-type-surface.md`
- `batch-cards/250-provider-pull-request-refresh-persistence-store.md`
- `batch-cards/251-provider-pull-request-refresh-persistence-diagnostics-control.md`
- `batch-cards/252-provider-pull-request-refresh-persistence-blocker-tests.md`
- `batch-cards/253-provider-pull-request-refresh-persistence-validation-closeout.md`

## Acceptance Criteria

- [x] Stopped PR/MR refresh records can be persisted and read back.
- [x] Duplicate persisted refresh ids produce no-op records and do not rewrite
  storage.
- [x] Missing evidence refs block persistence.
- [x] Credential material, provider payloads, raw payload retention, real
  credential resolution, provider network calls, callbacks, interruption,
  recovery execution, and task mutation block persistence.
- [x] Diagnostics and control DTOs expose sanitized counts only.
- [x] Focused tests pass.

## Closeout

`nucleus-server` now exposes `provider_forge_pull_request_refresh_persistence`.

The module is split into:

- front-door module
- `blockers`
- `types`
- `record_builder`
- `store`
- `diagnostics`
- focused tests and support fixtures

It remains stopped by default:

- no credential material is resolved
- no provider network calls are made
- no provider effects are executed
- no callbacks, interruption, recovery execution, task mutation, or raw
  provider payload retention are granted

Next lane:

- consolidate the stopped provider read-intent pattern before adding more read
  families
