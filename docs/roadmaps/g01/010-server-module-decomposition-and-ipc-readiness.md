# 010 Server Module Decomposition And IPC Readiness

Status: active
Owner: Tom
Updated: 2026-06-16

## Goal

Prepare executable Tauri IPC readiness without letting server modules become
god files or starting desktop UI too early.

## Scope

- Split oversized server modules into smaller focused files.
- Keep public crate exports stable through `lib.rs`.
- Add serialization-ready control envelope readiness types.
- Add a narrow Tauri IPC command boundary skeleton.
- Prove one local request/response path through a fixture before scaffolding
  the desktop shell.

## Out Of Scope

- Tauri desktop scaffolding.
- Desktop panels.
- Live event subscriptions.
- HTTP, WebSocket, local socket, or remote pairing transports.
- Command execution.
- Provider process lifecycle.

## Evidence

`effigy doctor` currently reports god-file findings in server and storage code:

- `crates/nucleus-server/src/request_handler.rs`
- `crates/nucleus-server/src/local_transport.rs`
- `crates/nucleus-server/src/secret_store.rs`
- `crates/nucleus-local-store/src/sqlite.rs`
- `crates/nucleus-local-store/src/fixtures.rs`

This roadmap addresses the server modules touched by the local transport and
IPC runway first. Storage decomposition remains a later storage-lane concern.

## Decisions

- Module decomposition comes before more transport implementation.
- `lib.rs` remains the crate front door and export index.
- IPC work starts with envelope readiness and command-boundary shape, not a
  Tauri app scaffold.
- Desktop scaffolding remains deferred until an IPC-like fixture can prove one
  request/response path through the server boundary.

## Execution Plan

- [ ] Split local transport module boundaries.
- [ ] Split request handler module boundaries.
- [ ] Add control API serialization envelope readiness.
- [ ] Add Tauri IPC command boundary skeleton.
- [ ] Prove Tauri IPC command path with fixture.
- [ ] Reassess desktop scaffold after IPC boundary.

## Acceptance Criteria

- [ ] Local transport fixture code is split into focused server modules without
  changing behavior.
- [ ] Request handler code is split into focused server modules without
  changing behavior.
- [ ] Serialization readiness names control request/response envelope needs
  without implementing app transport.
- [ ] Tauri IPC command boundary can route one request/response path through a
  fixture.
- [ ] No Tauri UI, socket listener, HTTP server, command runner, provider
  process, or live subscription behavior is introduced.

## Cards

- `docs/roadmaps/g01/batch-cards/099-split-local-transport-module-boundaries.md`
- `docs/roadmaps/g01/batch-cards/100-split-request-handler-module-boundaries.md`
- `docs/roadmaps/g01/batch-cards/101-add-control-api-serialization-envelope-readiness.md`
- `docs/roadmaps/g01/batch-cards/102-add-tauri-ipc-command-boundary-skeleton.md`
- `docs/roadmaps/g01/batch-cards/103-prove-tauri-ipc-command-path-with-fixture.md`
- `docs/roadmaps/g01/batch-cards/104-reassess-desktop-scaffold-after-ipc-boundary.md`

## Deferred Lanes

- Storage module decomposition.
- Secret store module decomposition.
- Desktop app scaffolding.
- Desktop panels.
- Live event subscriptions.
