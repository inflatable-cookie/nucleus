# 108 Add Tauri Command Handler Adapter

Status: planned
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
