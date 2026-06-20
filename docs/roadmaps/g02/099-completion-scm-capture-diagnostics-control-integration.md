# 099 Completion SCM Capture Diagnostics Control Integration

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Expose persisted completion SCM capture-admission diagnostics through the
read-only control surface without executing SCM or forge effects.

## Governing Refs

- `docs/roadmaps/g02/097-completion-scm-capture-admission.md`
- `docs/roadmaps/g02/098-completion-scm-capture-admission-persistence.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add a sanitized control DTO for capture-admission diagnostics.
- [x] Add diagnostics query vocabulary.
- [x] Route persisted capture-admission diagnostics through the request handler.
- [x] Keep missing state empty and read-only.
- [x] Keep external effects gated.

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

- `batch-cards/459-completion-scm-capture-control-dto.md`
- `batch-cards/460-completion-scm-capture-query-vocabulary.md`
- `batch-cards/461-completion-scm-capture-request-handler-routing.md`
- `batch-cards/462-completion-scm-capture-control-authority.md`
- `batch-cards/463-completion-scm-capture-control-closeout.md`

## Acceptance Criteria

- [x] Control DTO exposes counts only.
- [x] Diagnostics query round-trips through request/response envelopes.
- [x] Handler reads persisted capture admissions.
- [x] Missing state is empty and read-only.
- [x] No external effects execute.

## Closeout

Completion SCM capture-admission diagnostics now have a sanitized control DTO,
request/response vocabulary, and request-handler routing from persisted
admissions. The surface exposes counts only and grants no external authority.

Next lane: define SCM capture-preparation records from persisted capture
admissions without executing any SCM or forge action.
