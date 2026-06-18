# 106 Tauri IPC Diagnostics Boundary

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../025-diagnostics-control-dto-serialization.md`

## Purpose

Keep diagnostics DTOs usable through Tauri IPC without making IPC authoritative.

## Scope

- Confirm diagnostics response DTOs fit the Tauri IPC boundary.
- Add or update IPC boundary fixtures if needed.
- Keep diagnostics as control API payloads.

## Acceptance Criteria

- Tauri IPC can carry diagnostics DTOs.
- IPC remains transport-only.
- Desktop state remains non-authoritative.

## Validation

- `cargo test -p nucleus-server tauri`
- `cargo test -p nucleus-server diagnostics`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if IPC starts owning diagnostics state.
