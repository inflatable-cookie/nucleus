# 117 SCM Capture Operator Review Readiness

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Turn replay-only SCM capture workflow diagnostics into explicit operator review
readiness records before any change-request preparation or SCM mutation lane.

This lane is still not a commit, branch, push, PR, merge, forge mutation,
provider, callback, interruption, recovery, or raw-output lane.

## Governing Refs

- `docs/roadmaps/g02/115-scm-capture-workflow-composition.md`
- `docs/roadmaps/g02/116-scm-capture-workflow-control-integration.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define operator review readiness records over SCM capture workflow
  projections.
- [x] Require completed workflow stages before review readiness.
- [x] Surface blocked, missing, and repair-required workflow states.
- [x] Keep review readiness separate from change-request preparation.
- [x] Keep raw output and mutation authority blocked.

## Execution Plan

- [x] Review readiness record batch.
- [x] Review blocker batch.
- [x] Review diagnostics batch.
- [x] Review authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/549-scm-capture-review-readiness-records.md`
- `batch-cards/550-scm-capture-review-blockers.md`
- `batch-cards/551-scm-capture-review-diagnostics.md`
- `batch-cards/552-scm-capture-review-authority.md`
- `batch-cards/553-scm-capture-review-closeout.md`

## Acceptance Criteria

- [x] Review readiness records admit only completed replay workflows.
- [x] Missing, blocked, and repair-required workflows remain visible.
- [x] Review readiness grants no change-request or SCM mutation authority.
- [x] Diagnostics summarize ready and blocked review candidates.
- [x] Validation passes or blockers are recorded.
