# 011 Desktop Serialization And Shell Bootstrap

Status: active
Owner: Tom
Updated: 2026-06-16

## Goal

Bridge the server IPC-shaped boundary into a real desktop-callable Tauri command
path, then scaffold only the minimal desktop shell.

## Scope

- Name the control API wire format and codec boundary.
- Add serializable control envelope DTOs.
- Add a Tauri command handler adapter that routes into the server boundary.
- Scaffold the desktop shell only after one command path can compile.
- Reassess first panel readiness after shell bootstrap.

## Out Of Scope

- Desktop panels.
- Live subscriptions.
- Remote transport.
- Command execution.
- Provider process lifecycle.
- Production auth.

## Decisions

- Serialization comes before Tauri command wiring.
- Tauri command wiring comes before desktop scaffolding.
- The first desktop scaffold is shell bootstrap plus one control command path,
  not a panel framework.
- UI panels remain deferred until the desktop can call the server boundary.

## Execution Plan

- [ ] Name control API wire format and codec boundary.
- [ ] Add serializable control envelope DTOs.
- [ ] Add Tauri command handler adapter.
- [ ] Scaffold desktop shell with control command.
- [ ] Reassess first desktop panel readiness.

## Acceptance Criteria

- [ ] Wire format and versioning are explicit before serde work.
- [ ] Serializable DTOs do not replace server authority types.
- [ ] Tauri command adapter routes through the server boundary.
- [ ] Desktop scaffold is shell-only and contains no panels.
- [ ] No provider process, command runner, live subscription, or remote
  transport behavior is introduced.

## Cards

- `docs/roadmaps/g01/batch-cards/106-name-control-api-wire-format-and-codec-boundary.md`
- `docs/roadmaps/g01/batch-cards/107-add-serializable-control-envelope-dtos.md`
- `docs/roadmaps/g01/batch-cards/108-add-tauri-command-handler-adapter.md`
- `docs/roadmaps/g01/batch-cards/109-scaffold-desktop-shell-with-control-command.md`
- `docs/roadmaps/g01/batch-cards/110-reassess-first-desktop-panel-readiness.md`

## Deferred Lanes

- Desktop panels.
- Terminal and browser panel implementation.
- Editor and SCM panel implementation.
- Live event subscriptions.
- Remote server pairing.
