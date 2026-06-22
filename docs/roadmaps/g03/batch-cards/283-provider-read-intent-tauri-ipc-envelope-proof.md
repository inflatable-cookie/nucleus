# 283 Provider Read-Intent Tauri IPC Envelope Proof

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../075-provider-read-intent-tauri-ipc-consumption.md`

## Purpose

Prove provider read-intent can pass through the Tauri IPC command adapter using
the serialized control-envelope DTO.

## Acceptance Criteria

- [x] Fixture-backed Tauri IPC adapter accepts `ProviderReadIntent`.
- [x] Request serializes through `ControlRequestEnvelopeDto`.
- [x] Response decodes through `ControlResponseBodyDto::ProviderReadIntent`.
- [x] Projection remains read-only.
- [x] JSON output omits credential material, authorization data, and raw
  provider payload fields.
