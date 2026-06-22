# 080 Provider Readiness Overview Tauri IPC Consumption

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Expose Provider Readiness Overview through the desktop Tauri IPC command
adapter without adding visible UI.

This lane proves the client transport can consume the same sanitized overview
that `nucleusd` and Effigy can inspect.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/077-provider-readiness-overview-projection.md`
- `docs/roadmaps/g03/078-provider-readiness-overview-query-control.md`
- `docs/roadmaps/g03/079-provider-readiness-overview-nucleusd-query.md`

## Goals

- [x] Reuse the serialized control-envelope query path.
- [x] Add desktop IPC consumption of Provider Readiness Overview.
- [x] Return the typed sanitized response DTO.
- [x] Keep the lane read-only and effect-free.
- [x] Avoid visible UI expansion.

## Execution Plan

- [x] Select the desktop IPC surface.
- [x] Add the serialized envelope proof.
- [x] Add focused IPC tests.
- [x] Validate and close out.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/301-provider-readiness-overview-tauri-ipc-surface-selection.md`
- `batch-cards/302-provider-readiness-overview-tauri-ipc-envelope-proof.md`
- `batch-cards/303-provider-readiness-overview-tauri-ipc-validation-closeout.md`

## Acceptance Criteria

- [x] Desktop IPC can request Provider Readiness Overview.
- [x] IPC response uses serialized control-envelope DTOs.
- [x] Tests prove sanitized no-effect response behavior.
- [x] No visible UI panel is added.
- [x] No provider credential resolution, network call, mutation, callback,
  interruption, recovery execution, task mutation, or raw payload retention is
  added.

## Stop Conditions

- Stop before visible UI.
- Stop before live provider reads.
- Stop before credential resolution.
- Stop before provider effects.

## Closeout

The fixture-backed Tauri IPC command adapter now accepts a serialized Provider
Readiness Overview query and returns the typed sanitized response DTO. The test
coverage asserts the overview id, projection id, unknown empty-store status,
missing evidence family count, no-effect flags, and absence of credential or
raw provider payload fields.

The next lane should select the product consumption path before adding a
visible panel.
