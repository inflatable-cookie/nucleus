# 120 SCM Capture Review Decision Control Integration

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Expose persisted SCM capture operator review decisions through read-only control
diagnostics before change-request preparation or SCM mutation work begins.

This lane is still not a checkout, worktree, branch, commit, push, PR, merge,
provider, callback, interruption, recovery, or raw-output lane.

## Governing Refs

- `docs/roadmaps/g02/118-scm-capture-review-control-integration.md`
- `docs/roadmaps/g02/119-scm-capture-review-decision-persistence.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add a sanitized control DTO for review-decision diagnostics.
- [x] Add diagnostics query vocabulary for review decisions.
- [x] Route persisted decision diagnostics through the request handler.
- [x] Include review decisions in aggregate diagnostics snapshots.
- [x] Keep change-request, SCM, forge, provider, callback, interruption,
  recovery, and raw-output authority absent.

## Execution Plan

- [x] Review decision control DTO batch.
- [x] Review decision query vocabulary batch.
- [x] Review decision handler routing batch.
- [x] Review decision control authority batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/564-scm-capture-review-decision-control-dto.md`
- `batch-cards/565-scm-capture-review-decision-query-vocabulary.md`
- `batch-cards/566-scm-capture-review-decision-handler-routing.md`
- `batch-cards/567-scm-capture-review-decision-control-authority.md`
- `batch-cards/568-scm-capture-review-decision-control-closeout.md`

## Acceptance Criteria

- [x] Review-decision diagnostics serialize as sanitized control DTOs.
- [x] `ScmCaptureReviewDecision` diagnostics queries round-trip through the
  control API vocabulary.
- [x] Request-handler diagnostics read persisted decision records.
- [x] Aggregate diagnostics include review-decision diagnostics.
- [x] Review-decision control grants no change-request, SCM, forge, provider,
  callback, interruption, recovery, or raw-output authority.
