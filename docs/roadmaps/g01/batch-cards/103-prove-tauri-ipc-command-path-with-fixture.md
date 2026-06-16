# 103 Prove Tauri IPC Command Path With Fixture

Status: planned
Owner: Tom
Updated: 2026-06-16

## Goal

Prove one Tauri IPC-shaped request/response path through a fixture before
desktop scaffolding.

## Scope

- Add a fixture that exercises the Tauri IPC command boundary.
- Route a control request through `LocalControlRequestHandler`.
- Prove one read-only state query response.
- Prove errors remain server-shaped, not UI-owned.

## Out Of Scope

- Tauri app scaffolding.
- Real IPC transport.
- State mutation execution.
- Live subscriptions.

## Promotion Targets

- `crates/nucleus-server`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/010-server-module-decomposition-and-ipc-readiness.md`

## Acceptance Criteria

- The fixture proves request/response routing through the future IPC boundary.
- The server remains the authority for state and errors.
- No desktop shell or Tauri runtime is required.

## Validation

```sh
cargo test --workspace
cargo fmt --all --check
```
