# 082 Provider Readiness Overview Desktop Proof Surface

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Render Provider Readiness Overview in the disposable desktop proof interface
without adding provider authority.

This lane turns the proven server, envelope, CLI, Effigy, and Tauri IPC path
into a visible read-only product proof.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/077-provider-readiness-overview-projection.md`
- `docs/roadmaps/g03/078-provider-readiness-overview-query-control.md`
- `docs/roadmaps/g03/079-provider-readiness-overview-nucleusd-query.md`
- `docs/roadmaps/g03/080-provider-readiness-overview-tauri-ipc-consumption.md`
- `docs/roadmaps/g03/081-provider-readiness-overview-product-consumption-decision.md`

## Goals

- [x] Add a read-only desktop proof surface for the overview DTO.
- [x] Keep the UI disposable and server-owned.
- [x] Show readiness status, family counts, blocker/evidence counts, and
  no-effect flags.
- [x] Avoid visual design invention beyond existing proof-shell patterns.
- [x] Avoid provider refresh, credential resolution, provider effects, task
  mutation, and raw payload display.

## Execution Plan

- [x] Inspect existing desktop proof panel structure.
- [x] Add the smallest provider-readiness overview client request path.
- [x] Render the overview with existing proof-shell components/styles.
- [x] Add focused frontend/Rust boundary validation where available.
- [x] Close with docs and QA.

## Batch Cards

Ready cards:

None.

Planned cards:

- `batch-cards/307-provider-readiness-overview-desktop-surface-audit.md`
- `batch-cards/308-provider-readiness-overview-desktop-request-path.md`
- `batch-cards/309-provider-readiness-overview-desktop-rendering.md`
- `batch-cards/310-provider-readiness-overview-desktop-validation-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [x] Desktop can request Provider Readiness Overview through the existing
  Tauri IPC path.
- [x] The proof surface renders readiness status and key counts.
- [x] The surface displays no-effect flags.
- [x] The surface does not trigger live provider refresh or provider effects.
- [x] The surface does not expose credential material or raw provider payloads.
- [x] Existing desktop proof-shell posture is preserved.

## Stop Conditions

- Stop before provider refresh.
- Stop before credential resolution.
- Stop before provider effects.
- Stop before durable UI design commitments.
- Stop before broad frontend redesign.

## Closeout

Provider Readiness Overview is now visible in the disposable desktop proof
shell. The surface uses the existing Tauri IPC control envelope, renders the
typed sanitized overview DTO, exposes readiness counts and no-effect flags, and
adds no provider refresh, credential resolution, provider effects, task
mutation, or raw payload display.

The next useful lane is seeded evidence proof so the same panel can be
validated against represented provider-readiness data instead of only the
empty-store unknown state.
