# 009 Local Transport And Desktop Bootstrap Prep

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add the first local control transport boundary and desktop bootstrap prep
without scaffolding the Tauri UI.

## Scope

- Define a local control transport trait boundary.
- Add an in-process control client fixture for request/response behavior.
- Route the in-process fixture through `LocalControlRequestHandler`.
- Add Tauri IPC schema readiness types without implementing IPC.
- Reassess whether the desktop shell can be scaffolded.

## Out Of Scope

- Tauri app scaffolding.
- Tauri IPC implementation.
- HTTP server implementation.
- WebSocket implementation.
- Local socket implementation.
- Remote pairing.
- Live subscriptions.
- Command execution.
- Provider process lifecycle.

## Decisions

- In-process local transport is the first executable client fixture.
- Tauri IPC remains the preferred future desktop transport, but it should be
  prepared as schema/readiness first.
- Desktop UI should not start until a local client fixture proves request and
  response behavior through the server boundary.

## Execution Plan

- [x] Add local control transport trait boundary.
- [x] Add in-process control client fixture.
- [x] Route fixture requests through `LocalControlRequestHandler`.
- [x] Add Tauri IPC schema readiness types.
- [x] Reassess desktop shell scaffold readiness.

## Acceptance Criteria

- [x] Transport traits are local and transport-neutral.
- [x] In-process fixture can submit `ServerControlRequest` values and receive
  `ServerControlResponse` values.
- [x] Fixture tests prove read-only state query behavior through the transport
  boundary.
- [x] Tauri IPC readiness names schema and bootstrap needs without implementing
  IPC.
- [x] No Tauri UI, socket listener, HTTP server, command runner, provider
  process, or live subscription behavior is introduced.

## Cards

- `docs/roadmaps/g01/batch-cards/093-add-local-control-transport-trait-boundary.md`
- `docs/roadmaps/g01/batch-cards/094-add-in-process-control-client-fixture.md`
- `docs/roadmaps/g01/batch-cards/095-route-in-process-fixture-through-handler.md`
- `docs/roadmaps/g01/batch-cards/096-add-tauri-ipc-schema-readiness-types.md`
- `docs/roadmaps/g01/batch-cards/097-reassess-desktop-shell-scaffold-readiness.md`

## Deferred Lanes

- Tauri app scaffolding.
- Desktop panels.
- Socket and HTTP transport.
- Remote auth and pairing.
- Live event subscriptions.
