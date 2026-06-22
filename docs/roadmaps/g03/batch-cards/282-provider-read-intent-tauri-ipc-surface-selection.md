# 282 Provider Read-Intent Tauri IPC Surface Selection

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../075-provider-read-intent-tauri-ipc-consumption.md`

## Purpose

Choose the next provider read-intent consumption surface after the `nucleusd`
query proof.

## Decision

Use the existing Tauri IPC command adapter as the next proof surface.

Rationale:

- it verifies desktop transport readiness without designing visible UI
- it reuses the serialized control-envelope contract
- it does not add more provider read-family fan-out
- it keeps provider effects blocked

## Acceptance Criteria

- [x] Consumption surface is chosen before implementation.
- [x] The surface is transport proof, not product UI.
- [x] The lane remains read-only and provider-effect-free.
