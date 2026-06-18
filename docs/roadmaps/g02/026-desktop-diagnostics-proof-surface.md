# 026 Desktop Diagnostics Proof Surface

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Add a disposable desktop proof surface for the new diagnostics query path.

This is not the final UI design. It proves the server functions can be
inspected from the client without client-side authority drift.

## Governing Refs

- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/roadmaps/g02/024-diagnostics-control-api-query-surface.md`
- `docs/roadmaps/g02/025-diagnostics-control-dto-serialization.md`

## Goals

- [x] Add desktop control helpers for diagnostics queries.
- [x] Add proof panels for steward and Effigy diagnostics.
- [x] Add proof panels for sync and SCM diagnostics.
- [x] Preserve loading, empty, unsupported, and error states.

## Execution Plan

- [x] Control helper batch: add TypeScript query helpers.
- [x] Steward/Effigy panel batch: render read-only diagnostics.
- [x] Sync/SCM panel batch: render read-only diagnostics.
- [x] State batch: handle loading, empty, unsupported, and errors.
- [x] Validation batch: run desktop checks and Rust gates.

## Batch Cards

Completed cards:

- `batch-cards/109-desktop-diagnostics-control-helper.md`
- `batch-cards/110-steward-effigy-diagnostics-panel.md`
- `batch-cards/111-sync-scm-diagnostics-panel.md`
- `batch-cards/112-desktop-diagnostics-loading-error-states.md`
- `batch-cards/113-desktop-diagnostics-proof-validation.md`

## Acceptance Criteria

- [x] Desktop can request and render diagnostics read models.
- [x] Desktop cannot mutate diagnostics state.
- [x] The proof surface remains explicitly disposable.

## Outcome

The desktop proof shell can query and render steward, Effigy, management sync,
and SCM diagnostics through the control envelope. The panel is read-only and
keeps loading, unsupported, error, and empty live-record states explicit.

## Gate

Do not start final UI design or layout work here.
