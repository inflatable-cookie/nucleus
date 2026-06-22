# 075 Provider Read-Intent Tauri IPC Consumption

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Prove the existing Tauri IPC command adapter can consume the provider
read-intent query through the serialized control-envelope boundary.

This lane does not add visible UI, new read families, provider writes,
credential resolution, or network access. It only verifies that the first
desktop control-plane transport can request and receive the read-only
projection.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/071-provider-read-intent-control-boundary.md`
- `docs/roadmaps/g03/073-provider-read-intent-serialized-control-envelope.md`
- `docs/roadmaps/g03/074-provider-read-intent-nucleusd-query.md`

## Goals

- [x] Select the next consumption surface conservatively.
- [x] Route provider read-intent through the Tauri IPC command adapter.
- [x] Assert the response remains a sanitized read-only projection.
- [x] Block provider effects, credential material, and raw provider payloads.
- [x] Avoid visible UI expansion.

## Execution Plan

- [x] Treat Tauri IPC as the next transport proof.
- [x] Add a fixture-backed IPC adapter test.
- [x] Validate focused IPC and provider read-intent paths.
- [x] Close the lane with a product decision gate.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/282-provider-read-intent-tauri-ipc-surface-selection.md`
- `batch-cards/283-provider-read-intent-tauri-ipc-envelope-proof.md`
- `batch-cards/284-provider-read-intent-tauri-ipc-validation-closeout.md`

## Acceptance Criteria

- [x] Tauri IPC can submit a serialized provider read-intent query.
- [x] The response body decodes as `ProviderReadIntent`.
- [x] The projection reports explicit no-effect flags.
- [x] The serialized response omits credential material and raw provider
  payloads.
- [x] Focused server tests pass.

## Closeout

Provider read-intent is now proven through:

- in-process control handler
- serialized control-envelope DTO
- `nucleusd query provider-read-intent`
- root Effigy selector
- Tauri IPC command adapter

The next step should be a product consumption decision. The implementation now
has enough transport proof for the current read-only projection; adding UI,
more read-family fan-out, or provider effects would be speculative without that
decision.
