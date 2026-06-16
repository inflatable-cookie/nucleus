# 099 Split Local Transport Module Boundaries

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Split `nucleus-server` local transport code into focused modules without
changing behavior.

## Scope

- Move local transport traits and value types into a named module.
- Move scripted in-process fixture code into a fixture module.
- Move handler-backed in-process fixture code into a fixture module.
- Preserve public exports from `nucleus-server::lib`.
- Keep tests passing after the split.

## Out Of Scope

- New transport behavior.
- Tauri IPC implementation.
- Network transport.
- Request handler refactoring.

## Promotion Targets

- `crates/nucleus-server`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/010-server-module-decomposition-and-ipc-readiness.md`

## Acceptance Criteria

- `local_transport.rs` becomes a small module index or focused module.
- Existing local transport tests still pass.
- Public types remain exported through `nucleus-server`.
- No request/response semantics change.

## Validation

```sh
cargo test --workspace
cargo fmt --all --check
```

## Decisions

- `local_transport/mod.rs` is now the module index.
- Boundary traits and value types live in `local_transport/types.rs`.
- Scripted in-process fixture code lives in
  `local_transport/scripted_fixture.rs`.
- Handler-backed fixture code lives in `local_transport/handler_fixture.rs`.
- Local transport tests live in `local_transport/tests.rs`.

## Closeout

Split local transport code into focused modules without changing public
exports or transport behavior.
