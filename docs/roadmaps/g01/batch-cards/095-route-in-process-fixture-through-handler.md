# 095 Route In Process Fixture Through Handler

Status: planned
Owner: Tom
Updated: 2026-06-16

## Goal

Route in-process fixture requests through `LocalControlRequestHandler`.

## Scope

- Connect fixture transport to the handler.
- Prove read-only state query behavior through the transport boundary.
- Prove command receipt behavior through the transport boundary.

## Out Of Scope

- State mutation execution.
- Runtime execution.
- Tauri IPC.
- Network transport.

## Promotion Targets

- `crates/nucleus-server`
- `docs/roadmaps/g01/009-local-transport-and-desktop-bootstrap-prep.md`
