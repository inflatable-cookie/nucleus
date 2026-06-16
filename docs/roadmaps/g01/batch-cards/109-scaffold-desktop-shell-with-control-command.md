# 109 Scaffold Desktop Shell With Control Command

Status: planned
Owner: Tom
Updated: 2026-06-16

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

- Desktop shell starts locally.
- One control command can be invoked through Tauri.
- No panel framework or product UI is introduced.

## Validation

```sh
cargo test --workspace
cargo fmt --all --check
```
