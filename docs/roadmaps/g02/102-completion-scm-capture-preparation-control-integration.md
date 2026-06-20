# 102 Completion SCM Capture Preparation Control Integration

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Expose persisted completion SCM capture-preparation diagnostics through the
read-only control surface without executing SCM or forge effects.

## Governing Refs

- `docs/roadmaps/g02/100-completion-scm-capture-preparation-records.md`
- `docs/roadmaps/g02/101-completion-scm-capture-preparation-persistence.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add a sanitized control DTO for preparation diagnostics.
- [x] Add diagnostics query vocabulary.
- [x] Route persisted preparation diagnostics through the request handler.
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

- `batch-cards/474-completion-scm-capture-preparation-control-dto.md`
- `batch-cards/475-completion-scm-capture-preparation-query-vocabulary.md`
- `batch-cards/476-completion-scm-capture-preparation-handler-routing.md`
- `batch-cards/477-completion-scm-capture-preparation-control-authority.md`
- `batch-cards/478-completion-scm-capture-preparation-control-closeout.md`

## Acceptance Criteria

- [x] Control DTO exposes counts only.
- [x] Diagnostics query round-trips through request/response envelopes.
- [x] Handler reads persisted preparation records.
- [x] Missing state is empty and read-only.
- [x] No external effects execute.

## Closeout

Completion SCM capture-preparation diagnostics now have a sanitized control
DTO, request/response vocabulary, and request-handler routing from persisted
preparation records. The surface exposes counts only and grants no SCM, forge,
provider, callback, recovery, or raw-material authority.

Next lane: define SCM capture driver dry-run planning records, still without
executing capture, publish, review-request, merge, or forge effects.
