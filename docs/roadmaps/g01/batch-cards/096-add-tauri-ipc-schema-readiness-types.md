# 096 Add Tauri IPC Schema Readiness Types

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Define Tauri IPC schema readiness without implementing IPC.

## Scope

- Name the command schema expectations.
- Name bootstrap blockers.
- Bind schema readiness to local transport readiness.

## Out Of Scope

- Tauri app scaffolding.
- Tauri command implementation.
- IPC serialization implementation.

## Promotion Targets

- `crates/nucleus-server`
- `apps/desktop/README.md`
- `docs/roadmaps/g01/009-local-transport-and-desktop-bootstrap-prep.md`

## Validation

```sh
cargo test --workspace
```

## Decisions

- Tauri IPC readiness lives in `tauri_ipc_readiness.rs`.
- The first desktop schema requires `SubmitControlRequest`,
  `GetBootstrapProfile`, `GetTransportReadiness`, and control request/response
  envelopes.
- Readiness is assessed against `LocalTransportReadiness`.
- Deferred implementation and serialization are explicit blockers.

## Closeout

Added Tauri IPC schema readiness vocabulary and tests.

No Tauri commands, IPC serialization, desktop app, socket listener, network
transport, command runner, provider process, or live subscription behavior was
introduced.
