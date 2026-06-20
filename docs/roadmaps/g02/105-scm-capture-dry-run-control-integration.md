# 105 SCM Capture Dry Run Control Integration

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Expose persisted SCM capture dry-run planning diagnostics through the read-only
control API without granting SCM, forge, provider, callback, interruption,
recovery, or raw-material authority.

## Governing Refs

- `docs/roadmaps/g02/103-scm-capture-driver-dry-run-planning.md`
- `docs/roadmaps/g02/104-scm-capture-dry-run-planning-persistence.md`
- `docs/roadmaps/g02/102-completion-scm-capture-preparation-control-integration.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add sanitized dry-run control DTOs.
- [x] Add diagnostics query vocabulary.
- [x] Route request handling from persisted dry-run planning records.
- [x] Preserve missing-state repair behavior.
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

- `batch-cards/489-scm-capture-dry-run-control-dto.md`
- `batch-cards/490-scm-capture-dry-run-query-vocabulary.md`
- `batch-cards/491-scm-capture-dry-run-request-handler-routing.md`
- `batch-cards/492-scm-capture-dry-run-control-authority-regressions.md`
- `batch-cards/493-scm-capture-dry-run-control-closeout.md`

## Acceptance Criteria

- [x] Dry-run diagnostics serialize through sanitized DTOs.
- [x] Request envelopes round-trip the dry-run diagnostics domain.
- [x] Handler routing reads persisted dry-run planning records.
- [x] Empty state remains read-only and repair-visible.
- [x] No SCM or forge effect executes.
