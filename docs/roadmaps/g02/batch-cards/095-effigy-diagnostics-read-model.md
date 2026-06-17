# 095 Effigy Diagnostics Read Model

Status: planned
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

- Clients can inspect Effigy health and planned validation.
- DTOs retain sanitized refs only.
- Disabled or missing Effigy state is explicit.

## Validation

- `cargo test -p nucleus-server effigy`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if DTOs need raw command output.
