# 101 Add Control API Serialization Envelope Readiness

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Name serialization readiness for control request and response envelopes before
implementing Tauri IPC.

## Scope

- Define serialization envelope readiness types in `nucleus-server`.
- Name required request and response envelope fields.
- Name blockers for id stability, error shape, versioning, and payload
  compatibility.
- Connect envelope readiness to Tauri IPC readiness.

## Out Of Scope

- Adding `serde` derives.
- Implementing Tauri commands.
- Implementing socket, HTTP, or WebSocket transport.
- Desktop scaffolding.

## Promotion Targets

- `crates/nucleus-server`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/010-server-module-decomposition-and-ipc-readiness.md`

## Acceptance Criteria

- Serialization readiness is explicit and test-covered.
- Tauri IPC readiness can report envelope blockers.
- No transport implementation is introduced.

## Validation

```sh
cargo test --workspace
cargo fmt --all --check
```

## Decisions

- Control API serialization readiness lives in
  `control_serialization_readiness.rs`.
- The first Tauri IPC envelope plan names request id, client id, request kind,
  response status, response body, error shape, and protocol version fields.
- Readiness blockers name stable identity, versioning, error shape, payload
  compatibility, and codec work without implementing them.
- Tauri IPC schema readiness can now consume explicit control serialization
  readiness.

## Closeout

Added type-only control API serialization readiness and tests.

No serde derives, wire format, Tauri commands, desktop scaffolding, socket,
HTTP, or WebSocket behavior was introduced.
