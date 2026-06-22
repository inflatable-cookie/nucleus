# 069 Provider Read-Intent Projection Control

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Implement a generic stopped provider read-intent projection/control surface
from persisted credential-status, repository-metadata, and PR/MR refresh
records.

This lane makes the proven stopped read-intent pattern visible as one aggregate
surface instead of continuing issue/comment/review/status read-family fan-out.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/068-provider-forge-read-pattern-consolidation.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`

## Goals

- [x] Project persisted credential-status, repository-metadata, and PR/MR
  refresh records into one generic read-intent entry list.
- [x] Preserve family, provider context, provider instance, forge provider,
  remote repo, operation family, status, blocker counts, and evidence counts.
- [x] Count ready, duplicate no-op, blocked, and repair-required records.
- [x] Expose a read-only control DTO with sanitized counts.
- [x] Keep projection files below warning pressure.

## Execution Plan

- [x] Generic read-intent projection types.
- [x] Family-specific projection entry builders.
- [x] Projection status mapping.
- [x] Control DTO aggregation.
- [x] Focused projection tests.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/257-provider-read-intent-projection-type-surface.md`
- `batch-cards/258-provider-read-intent-projection-entry-builders.md`
- `batch-cards/259-provider-read-intent-projection-control-dto.md`
- `batch-cards/260-provider-read-intent-projection-tests.md`
- `batch-cards/261-provider-read-intent-projection-validation-closeout.md`

## Acceptance Criteria

- [x] Projection groups credential-status, repository-metadata, and PR/MR
  persisted refresh records.
- [x] Projection reports ready, duplicate, blocked, and repair-required states.
- [x] Control DTO serializes sanitized counts only.
- [x] Projection performs no credential resolution, provider network call,
  provider effect, callback, interruption, recovery execution, task mutation,
  or raw provider payload retention.
- [x] Focused tests pass.

## Closeout

`nucleus-server` now exposes `provider_forge_read_intent_projection`.

The module is split into:

- front-door module
- `types`
- `entry_builder`
- `status_mapper`
- focused tests and support fixtures

It remains read-only and stopped by default:

- no credential material is resolved
- no provider network calls are made
- no provider effects are executed
- no callbacks, interruption, recovery execution, task mutation, or raw
  provider payload retention are granted

Next lane:

- compose the generic stopped provider read-intent projection from local store
  records through a read-only server query surface
