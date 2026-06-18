# 095 Effigy Diagnostics Read Model

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../023-client-read-model-and-diagnostics-runway.md`

## Purpose

Expose Effigy integration, health, selector inventory, and validation-plan
state to clients.

## Scope

- Add read-model records or DTOs for Effigy diagnostics.
- Show disabled, detected, enabled, missing, blocked, and unknown states.
- Keep raw Effigy output out of DTOs.

## Acceptance Criteria

- [x] Clients can inspect Effigy health and planned validation.
- [x] DTOs retain sanitized refs only.
- [x] Disabled or missing Effigy state is explicit.

## Outcome

- Added Effigy diagnostics DTOs for integration status, selector refs, health,
  validation-plan state, and evidence refs.
- Kept Effigy execution unavailable through diagnostics.

## Validation

- [x] `cargo test -p nucleus-server effigy`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if DTOs need raw command output.
