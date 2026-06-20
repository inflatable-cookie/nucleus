# 095 Completion SCM Readiness Control Integration

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Expose completion-to-SCM readiness through read-only server/control diagnostics
without executing SCM or forge effects.

## Governing Refs

- `docs/roadmaps/g02/094-completion-to-scm-change-request-readiness.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Compose completion SCM readiness from task-state history records.
- [x] Add a sanitized control DTO for readiness diagnostics.
- [x] Route the diagnostics query through the server request handler.
- [x] Preserve provider-neutral SCM vocabulary.
- [x] Keep SCM and forge execution gated out of scope.

## Execution Plan

- [x] Read-model composition batch.
- [x] Control DTO batch.
- [x] Diagnostics query vocabulary batch.
- [x] Request-handler routing batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/439-completion-scm-read-model-composition.md`
- `batch-cards/440-completion-scm-control-dto.md`
- `batch-cards/441-completion-scm-diagnostics-query-vocabulary.md`
- `batch-cards/442-completion-scm-request-handler-routing.md`
- `batch-cards/443-completion-scm-control-integration-closeout.md`

## Acceptance Criteria

- [x] Completion SCM readiness has a single read model composition point.
- [x] Control DTOs expose counts, statuses, refs, and adapter labels only.
- [x] Request-handler diagnostics can return completion SCM readiness.
- [x] Missing source state routes to repair/missing-state diagnostics.
- [x] No SCM capture, publish, review-request, merge, or forge effect executes.

## Closeout

Completion SCM readiness is now exposed as a read-only diagnostics domain.
The request handler currently reports missing task-state history as a repair
state because task-state history records are not yet persisted.

Next lane: persist live-evidence task-state history/control records and feed
them into completion SCM readiness diagnostics.
