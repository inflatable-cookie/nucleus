# 108 SCM Capture Dry Run Execution Control

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Expose persisted SCM capture dry-run execution diagnostics through read-only
control APIs without granting capture, publish, forge, provider, callback,
interruption, recovery, or raw-output authority.

## Governing Refs

- `docs/roadmaps/g02/105-scm-capture-dry-run-control-integration.md`
- `docs/roadmaps/g02/106-scm-capture-dry-run-execution-gate.md`
- `docs/roadmaps/g02/107-scm-capture-dry-run-execution-persistence.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add sanitized dry-run execution control DTOs.
- [x] Add diagnostics query vocabulary.
- [x] Route request handling from persisted execution receipts.
- [x] Preserve terminal and blocked outcome visibility.
- [x] Keep control API read-only.

## Execution Plan

- [x] Control DTO batch.
- [x] Query vocabulary batch.
- [x] Request-handler routing batch.
- [x] Authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/504-scm-capture-dry-run-execution-control-dto.md`
- `batch-cards/505-scm-capture-dry-run-execution-query-vocabulary.md`
- `batch-cards/506-scm-capture-dry-run-execution-handler-routing.md`
- `batch-cards/507-scm-capture-dry-run-execution-control-authority.md`
- `batch-cards/508-scm-capture-dry-run-execution-control-closeout.md`

## Acceptance Criteria

- [x] Execution diagnostics serialize through sanitized DTOs.
- [x] Request envelopes round-trip the execution diagnostics domain.
- [x] Handler routing reads persisted execution receipts.
- [x] Empty state returns sanitized zero counts.
- [x] No capture, publish, forge, provider, callback, recovery, or raw-output
  effect executes.
