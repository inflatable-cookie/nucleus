# 122 SCM Capture Change Request Preparation Control

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Persist and expose adapter-neutral SCM change-request preparation admission
records through read-only diagnostics before any SCM or forge execution lane.

This lane is still not branch creation, commit creation, push, publish, PR
creation, merge, provider write, callback response, interruption, recovery, or
raw-output retention.

## Governing Refs

- `docs/roadmaps/g02/120-scm-capture-review-decision-control-integration.md`
- `docs/roadmaps/g02/121-scm-capture-change-request-preparation-admission.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Persist change-request preparation admission records.
- [x] Expose preparation diagnostics through sanitized control DTOs.
- [x] Add diagnostics query vocabulary and request-handler routing.
- [x] Keep SCM, forge, provider, callback, interruption, recovery, and raw-output
  authority absent.
- [x] Select the next adapter-specific planning lane from evidence.

## Execution Plan

- [x] Preparation persistence batch.
- [x] Preparation control DTO batch.
- [x] Preparation query vocabulary batch.
- [x] Preparation handler routing batch.
- [x] Authority and closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/574-scm-change-request-prep-persistence.md`
- `batch-cards/575-scm-change-request-prep-control-dto.md`
- `batch-cards/576-scm-change-request-prep-query-vocabulary.md`
- `batch-cards/577-scm-change-request-prep-handler-routing.md`
- `batch-cards/578-scm-change-request-prep-control-closeout.md`

## Acceptance Criteria

- [x] Preparation admission records persist by stable id.
- [x] Preparation diagnostics serialize as sanitized DTOs.
- [x] Control API queries route persisted preparation diagnostics.
- [x] Aggregate diagnostics include preparation state.
- [x] No branch, commit, push, publish, forge, provider, callback, interruption,
  recovery, or raw-output authority is granted.
