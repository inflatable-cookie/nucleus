# 086 Stopped Provider Status Check Refresh

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Add the next provider read family as stopped status/check refresh records.

This lane extends the proven provider read-intent pattern without calling
provider networks. It should let Nucleus model CI/status/check readiness as
sanitized evidence for task completion and PR review flows before any merge,
provider write, or live refresh behavior exists.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/068-provider-forge-read-pattern-consolidation.md`
- `docs/roadmaps/g03/085-provider-readiness-product-closeout-and-next-lane-selection.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Model status/check refresh as a stopped provider read-intent family.
- [x] Persist sanitized status/check refresh records.
- [x] Fold status/check evidence into the generic read-intent projection.
- [x] Keep the readiness overview and drilldown read-only and effect-free.
- [x] Avoid credential resolution, provider network calls, provider writes,
  callbacks, interruption/recovery execution, task mutation, raw provider
  payload retention, and durable UI design commitments.

## Execution Plan

- [x] Add stopped status/check refresh type surface and blockers.
- [x] Add persistence and read-only diagnostics/control for status/check
  refresh records.
- [x] Extend provider read-intent projection/query/DTOs to include
  status/check refresh.
- [x] Update local desktop seed evidence only after server projection support
  exists.
- [x] Validate and close out the stopped status/check lane.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/328-provider-status-check-refresh-persistence-type-surface.md`
- `batch-cards/329-provider-status-check-refresh-persistence-store.md`
- `batch-cards/330-provider-status-check-refresh-persistence-diagnostics-control.md`
- `batch-cards/331-provider-status-check-refresh-persistence-blocker-tests.md`
- `batch-cards/332-provider-status-check-refresh-persistence-validation-closeout.md`
- `batch-cards/333-provider-read-intent-status-check-projection.md`
- `batch-cards/334-provider-read-intent-status-check-query-dto.md`
- `batch-cards/335-provider-readiness-status-check-seed-proof.md`
- `batch-cards/336-provider-status-check-refresh-lane-closeout.md`
- `batch-cards/323-provider-status-check-refresh-type-surface.md`
- `batch-cards/324-provider-status-check-refresh-record-builder.md`
- `batch-cards/325-provider-status-check-refresh-control-dto.md`
- `batch-cards/326-provider-status-check-refresh-blocker-tests.md`
- `batch-cards/327-provider-status-check-refresh-validation-closeout.md`

## Acceptance Criteria

- [x] Status/check refresh records are represented as stopped read intent.
- [x] Blocked states prove no credential material, provider payload, real
  credential resolution, provider network call, callback, interruption,
  recovery execution, task mutation, or raw provider payload retention.
- [x] Type/control DTO work only exposes sanitized refs and counts.
- [x] Tests prove the new family without requiring live provider access.
- [x] Persistence and persistence diagnostics/control are complete.
- [x] Projection, DTO integration, and desktop seed proof are complete.
- [x] Targeted validation passes; doctor remains warning-only/error-free.

## Current Slice

Completed:

- stopped status/check refresh type surface
- record builder
- read-only control DTO
- blocker tests for ready, repair-required, blocked live-work attempts, and
  sanitized DTO output

Next:

- follow `g03/088` provider live-read admission gate before any real provider
  network call, credential resolution, provider effect, status/check write, or
  raw payload retention.

## Stop Conditions

- Stop before live provider refresh.
- Stop before credential resolution.
- Stop before provider effects or status/check writes.
- Stop before merge or review workflow mutation.
- Stop before raw provider payload retention.
