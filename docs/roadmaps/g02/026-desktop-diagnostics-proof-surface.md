# 026 Desktop Diagnostics Proof Surface

Status: planned
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

- [ ] Add desktop control helpers for diagnostics queries.
- [ ] Add proof panels for steward and Effigy diagnostics.
- [ ] Add proof panels for sync and SCM diagnostics.
- [ ] Preserve loading, empty, unsupported, and error states.

## Execution Plan

- [ ] Control helper batch: add TypeScript query helpers.
- [ ] Steward/Effigy panel batch: render read-only diagnostics.
- [ ] Sync/SCM panel batch: render read-only diagnostics.
- [ ] State batch: handle loading, empty, unsupported, and errors.
- [ ] Validation batch: run desktop checks and Rust gates.

## Batch Cards

Planned cards:

- `batch-cards/109-desktop-diagnostics-control-helper.md`
- `batch-cards/110-steward-effigy-diagnostics-panel.md`
- `batch-cards/111-sync-scm-diagnostics-panel.md`
- `batch-cards/112-desktop-diagnostics-loading-error-states.md`
- `batch-cards/113-desktop-diagnostics-proof-validation.md`

## Acceptance Criteria

- [ ] Desktop can request and render diagnostics read models.
- [ ] Desktop cannot mutate diagnostics state.
- [ ] The proof surface remains explicitly disposable.

## Gate

Do not start final UI design or layout work here.
