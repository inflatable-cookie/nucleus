# 094 Add In Process Control Client Fixture

Status: planned
Owner: Tom
Updated: 2026-06-16

## Goal

Add an in-process control client fixture for local request/response behavior.

## Scope

- Implement the local transport trait for an in-process fixture.
- Keep the fixture test-only or clearly non-production.
- Prove it can carry control requests and responses.

## Out Of Scope

- Tauri IPC.
- Network transport.
- Background workers.

## Promotion Targets

- `crates/nucleus-server`
- `docs/roadmaps/g01/009-local-transport-and-desktop-bootstrap-prep.md`
