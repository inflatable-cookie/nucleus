# 118 SCM Capture Review Control Integration

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Expose SCM capture operator review readiness through read-only control
diagnostics before any operator decision, change-request preparation, SCM
mutation, or forge lane.

This lane is still not a commit, branch, push, PR, merge, forge mutation,
provider, callback, interruption, recovery, or raw-output lane.

## Governing Refs

- `docs/roadmaps/g02/116-scm-capture-workflow-control-integration.md`
- `docs/roadmaps/g02/117-scm-capture-operator-review-readiness.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add a sanitized control DTO for SCM capture review readiness.
- [x] Add diagnostics query vocabulary for SCM capture review readiness.
- [x] Route review readiness diagnostics from persisted workflow evidence.
- [x] Include review readiness in aggregate diagnostics snapshots.
- [x] Keep all operator decision and SCM mutation authority absent.

## Execution Plan

- [x] Review control DTO batch.
- [x] Query vocabulary batch.
- [x] Request-handler routing batch.
- [x] Control authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/554-scm-capture-review-control-dto.md`
- `batch-cards/555-scm-capture-review-query-vocabulary.md`
- `batch-cards/556-scm-capture-review-handler-routing.md`
- `batch-cards/557-scm-capture-review-control-authority.md`
- `batch-cards/558-scm-capture-review-control-closeout.md`

## Acceptance Criteria

- [x] Review readiness serializes as sanitized control DTOs.
- [x] `ScmCaptureReview` diagnostics queries round-trip through the control
  API vocabulary.
- [x] Request-handler diagnostics derive review readiness from persisted
  workflow evidence.
- [x] Aggregate diagnostics include review readiness without losing existing
  diagnostics.
- [x] Review readiness control grants no operator decision, change-request, SCM,
  forge, provider, callback, interruption, recovery, or raw-output authority.
