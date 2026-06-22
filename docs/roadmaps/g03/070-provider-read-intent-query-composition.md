# 070 Provider Read-Intent Query Composition

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Compose the generic stopped provider read-intent projection from local store
records through a read-only server query surface.

This lane makes the aggregate projection usable without provider network calls,
credential resolution, or more read-family fan-out.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/069-provider-read-intent-projection-control.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`

## Goals

- [x] Read persisted credential-status, repository-metadata, and PR/MR refresh
  records from local store.
- [x] Compose those records into the generic read-intent projection.
- [x] Expose source counts and a read-only query control DTO.
- [x] Keep the query surface stopped by default.
- [x] Keep query files below warning pressure.

## Execution Plan

- [x] Query result and control DTO types.
- [x] Local-store read composition.
- [x] Store-backed query tests.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/262-provider-read-intent-query-type-surface.md`
- `batch-cards/263-provider-read-intent-query-store-composition.md`
- `batch-cards/264-provider-read-intent-query-tests.md`
- `batch-cards/265-provider-read-intent-query-validation-closeout.md`

## Acceptance Criteria

- [x] Query composes projection from persisted local-store records.
- [x] Empty local store returns an empty projection.
- [x] Query control DTO serializes sanitized counts only.
- [x] Query performs no credential resolution, provider network call, provider
  effect, callback, interruption, recovery execution, task mutation, or raw
  provider payload retention.
- [x] Focused tests pass.

## Closeout

`nucleus-server` now exposes `provider_forge_read_intent_query`.

The module is split into:

- front-door query module
- `types`
- focused tests
- source-family test support fixtures

It remains read-only and stopped by default:

- no credential material is resolved
- no provider network calls are made
- no provider effects are executed
- no callbacks, interruption, recovery execution, task mutation, or raw
  provider payload retention are granted

Next lane:

- expose provider read-intent query results through the server/control boundary
  without enabling provider writes
