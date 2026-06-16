# 104 Reassess Desktop Scaffold After IPC Boundary

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Decide whether the desktop shell can be scaffolded after IPC boundary proof.

## Scope

- Check module decomposition results.
- Check serialization readiness.
- Check IPC command boundary fixture coverage.
- Decide whether Tauri scaffolding starts next or needs another server runway.

## Out Of Scope

- Scaffolding Tauri.
- Implementing panels.
- Implementing live subscriptions.

## Promotion Targets

- `apps/desktop/README.md`
- `docs/roadmaps/g01/README.md`
- `docs/roadmaps/g01/batch-cards/README.md`

## Acceptance Criteria

- Desktop scaffold readiness is explicit.
- If ready, the next card scopes only shell bootstrap and no panels.
- If not ready, the blocker is documented and routed to the next server card.

## Validation

```sh
cargo test --workspace
effigy qa:docs
effigy qa:northstar
```

## Decision

Do not scaffold the desktop shell yet.

The server now has modular local transport and request-handler code,
serialization readiness vocabulary, a Tauri IPC command boundary skeleton, and
a fixture-backed request/response proof. It still lacks a real serializable
wire envelope, Tauri command macro wiring, app bootstrap configuration, and a
desktop-side command caller. Scaffolding the shell now would create a desktop
project before the command contract can be compiled through Tauri.

## Follow-On Work

- Compile the desktop serialization and shell bootstrap runway.
- Implement real control API serialization only after the wire format is named.
- Add Tauri command macro wiring only after serialization is testable.
- Keep panels out of the first desktop scaffold.

## Closeout

Desktop scaffolding remains deferred.

The next lane should bridge serialization readiness into a real app-callable
Tauri command path before creating panel UI.
