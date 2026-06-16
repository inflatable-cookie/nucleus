# 108 Add Tauri Command Handler Adapter

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add the server-side adapter that a future Tauri command can call.

## Scope

- Accept serializable request DTOs.
- Decode into server control requests.
- Route through the local request handler.
- Encode server responses into response DTOs.

## Out Of Scope

- Tauri macro command implementation.
- Desktop scaffolding.
- UI panels.
- Live subscriptions.

## Promotion Targets

- `crates/nucleus-server`
- `apps/desktop/README.md`
- `docs/roadmaps/g01/011-desktop-serialization-and-shell-bootstrap.md`

## Acceptance Criteria

- Adapter can prove one request/response path without a Tauri runtime.
- Decode and encode errors are explicit.
- Server remains state authority.

## Validation

```sh
cargo test --workspace
cargo fmt --all --check
```

## Decisions

- The adapter is `TauriIpcControlCommandAdapter`.
- It accepts `ControlRequestEnvelopeDto` values.
- It decodes into `ServerControlRequest`, routes through
  `LocalControlRequestHandler`, and encodes `ControlResponseEnvelopeDto`.
- Decode and encode failures use `ControlApiCodecError`.
- The adapter is runtime-free and does not use Tauri macros.

## Closeout

Added a server-side adapter a future Tauri command can call.

No Tauri macro command, desktop scaffold, UI panel, live subscription, or remote
transport behavior was introduced.
