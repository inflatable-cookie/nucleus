# 091 Add Local Transport Readiness Types

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Define first local transport readiness and desktop bootstrap posture types.

## Scope

- Name local transport candidates.
- Define readiness blockers.
- Define desktop bootstrap requirements.
- Keep transport implementation deferred.

## Out Of Scope

- HTTP server implementation.
- WebSocket implementation.
- Local socket implementation.
- Tauri IPC implementation.
- Remote pairing.

## Promotion Targets

- `crates/nucleus-server`
- `apps/desktop/README.md`
- `docs/roadmaps/g01/008-local-request-handling-and-transport-readiness.md`

## Validation

```sh
cargo test --workspace
```

## Decisions

- Local transport readiness lives in `nucleus-server/src/transport_readiness.rs`.
- The first candidates are in-process, Tauri IPC, Unix-domain socket, Windows
  named pipe, loopback HTTP, and custom.
- The first desktop profile prefers Tauri IPC and can name in-process fallback
  for early tests.
- Readiness blockers are explicit and do not implement any transport.

## Closeout

Added local transport candidate, readiness, blocker, desktop bootstrap
requirement, client bootstrap profile, and desktop bootstrap status types.

Tests cover preferred Tauri IPC readiness, in-process fallback readiness, and
blocked desktop bootstrap. No HTTP server, WebSocket, local socket, Tauri IPC,
remote pairing, request routing, or listener lifecycle was added.
