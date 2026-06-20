# 116 SCM Capture Workflow Control Integration

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Expose SCM capture workflow projection diagnostics through the read-only
control surface without granting mutation or external-effect authority.

## Governing Refs

- `docs/roadmaps/g02/115-scm-capture-workflow-composition.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add a sanitized control DTO for SCM capture workflow diagnostics.
- [x] Add diagnostics query vocabulary.
- [x] Route request-handler diagnostics from replay-only workflow records.
- [x] Prove control integration is read-only.
- [x] Keep raw output and mutation authority blocked.

## Execution Plan

- [x] Workflow control DTO batch.
- [x] Query vocabulary batch.
- [x] Handler routing batch.
- [x] Control authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/544-scm-capture-workflow-control-dto.md`
- `batch-cards/545-scm-capture-workflow-query-vocabulary.md`
- `batch-cards/546-scm-capture-workflow-handler-routing.md`
- `batch-cards/547-scm-capture-workflow-control-authority.md`
- `batch-cards/548-scm-capture-workflow-control-closeout.md`

## Acceptance Criteria

- [x] DTO serializes workflow counts, stage counts, evidence counts, and
  authority flags.
- [x] Diagnostics vocabulary includes SCM capture workflow.
- [x] Handler returns read-only workflow diagnostics.
- [x] Raw output and mutation authority remain absent.
- [x] Validation passes or blockers are recorded.
