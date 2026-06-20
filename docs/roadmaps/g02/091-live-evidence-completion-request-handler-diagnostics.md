# 091 Live Evidence Completion Request Handler Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Route live evidence completion read models through request-handler diagnostics
without adding task mutation, provider execution, SCM, or UI behavior.

## Governing Refs

- `docs/roadmaps/g02/090-live-evidence-completion-control-read-model.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add a diagnostics query variant or domain mapping for live evidence
      completion state.
- [x] Compose completion read-model DTOs from local server state.
- [x] Preserve missing-state and repair-required behavior.
- [x] Keep the request handler read-only.
- [x] Select the next lane from validated evidence.

## Execution Plan

- [x] Diagnostics query vocabulary batch.
- [x] Request-handler composition batch.
- [x] Missing-state and repair routing batch.
- [x] Read-only authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/419-live-evidence-completion-query-vocabulary.md`
- `batch-cards/420-live-evidence-completion-handler-composition.md`
- `batch-cards/421-live-evidence-completion-missing-state-repair-routing.md`
- `batch-cards/422-live-evidence-completion-handler-authority-regressions.md`
- `batch-cards/423-live-evidence-completion-request-handler-closeout.md`

## Acceptance Criteria

- [x] Diagnostics query vocabulary can name completion projection state.
- [x] Request handler can return sanitized completion DTOs.
- [x] Missing state becomes deferred/repair state.
- [x] Request handler grants no mutation/provider/SCM authority.
- [x] The next lane is selected from evidence after validation.
