# 102 Add Tauri IPC Command Boundary Skeleton

Status: planned
Owner: Tom
Updated: 2026-06-16

## Goal

Add a narrow Tauri IPC command boundary skeleton without scaffolding the desktop
app.

## Scope

- Name command boundary traits or value-shaped handlers for future Tauri IPC.
- Bind command submission to `ServerControlRequest` and
  `ServerControlResponse`.
- Keep the boundary local and synchronous unless the contract requires more.
- Preserve the distinction between command schema readiness and implementation.

## Out Of Scope

- Tauri project scaffolding.
- Tauri macro commands.
- IPC serialization implementation.
- Live subscriptions.

## Promotion Targets

- `crates/nucleus-server`
- `apps/desktop/README.md`
- `docs/roadmaps/g01/010-server-module-decomposition-and-ipc-readiness.md`

## Acceptance Criteria

- Tauri IPC command boundary is named and testable without a Tauri app.
- The boundary cannot become the authority for durable state.
- No desktop UI or transport listener is introduced.

## Validation

```sh
cargo test --workspace
cargo fmt --all --check
```
