# 096 Add Tauri IPC Schema Readiness Types

Status: planned
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
