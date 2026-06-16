# 109 Scaffold Desktop Shell With Control Command

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Scaffold the minimal Tauri desktop shell with one control command path.

## Scope

- Create the Tauri app scaffold.
- Wire one command to the server adapter.
- Add a minimal shell screen for command-path proof.
- Keep all project panels deferred.

## Out Of Scope

- Terminal, browser, editor, SCM, or task panels.
- Live subscriptions.
- Remote pairing.
- Provider process lifecycle.

## Promotion Targets

- `apps/desktop`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/011-desktop-serialization-and-shell-bootstrap.md`

## Acceptance Criteria

- [x] Desktop shell starts locally.
- [x] One control command can be invoked through Tauri.
- [x] No panel framework or product UI is introduced.

## Notes

- The first desktop scaffold uses Bun, Svelte, Tauri v2, and local Poodle
  component packages from `../poodle`.
- The TypeScript layer only builds the desktop shell, request DTO, and Tauri
  invoke call. Server state and command routing stay in Rust.
- The first command path is `submit_control_envelope`, backed by
  `TauriIpcControlCommandAdapter`.
- The app icon is a placeholder compile asset only.

## Validation

```sh
cargo check -p nucleus-desktop
bun run check
bun run build
```
