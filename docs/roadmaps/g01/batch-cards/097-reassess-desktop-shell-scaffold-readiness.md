# 097 Reassess Desktop Shell Scaffold Readiness

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Decide whether the Tauri shell can be scaffolded after local transport prep.

## Scope

- Check local transport trait readiness.
- Check in-process fixture coverage.
- Check Tauri IPC schema readiness.
- Decide whether desktop scaffolding starts next.

## Out Of Scope

- Scaffolding Tauri.
- Implementing desktop panels.
- Implementing IPC.

## Promotion Targets

- `apps/desktop/README.md`
- `docs/roadmaps/g01/README.md`
- `docs/roadmaps/g01/batch-cards/README.md`

## Validation

```sh
cargo test --workspace
effigy qa:docs
effigy qa:northstar
```

## Decision

Do not scaffold the Tauri shell yet.

The server now has a local request/response boundary, an in-process fixture,
handler-backed request routing, and Tauri IPC readiness vocabulary. It still
lacks Tauri command implementation, IPC serialization, desktop bootstrap
plumbing, and live event transport. Adding the shell now would create UI shape
before the local IPC contract is executable.

## Follow-On Work

- Split growing server modules before adding more transport code.
- Define serialization-ready control envelopes for Tauri IPC.
- Add a narrow Tauri IPC command boundary only after the envelope shape is
  testable.
- Reassess desktop scaffolding after the IPC boundary can prove one local
  request/response path.

## Closeout

Desktop scaffolding remains deferred.

The next lane should prepare server module decomposition and executable Tauri
IPC readiness instead of starting UI panels.
