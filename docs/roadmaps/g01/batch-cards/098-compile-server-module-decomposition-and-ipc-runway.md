# 098 Compile Server Module Decomposition And IPC Runway

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Compile the next runway for decomposing oversized server modules and preparing
executable Tauri IPC readiness.

## Scope

- Record why desktop scaffolding stays deferred.
- Add a roadmap for server module decomposition before more transport code.
- Add cards for serialization-ready IPC envelopes and a narrow command boundary.
- Keep UI panel work out of the runway.

## Out Of Scope

- Refactoring code.
- Implementing Tauri IPC.
- Scaffolding the desktop app.
- Adding panel UI.

## Promotion Targets

- `docs/roadmaps/g01/README.md`
- `docs/roadmaps/README.md`
- `docs/roadmaps/g01/batch-cards/README.md`

## Acceptance Criteria

- A new G01 roadmap sequences module decomposition before additional transport
  implementation.
- Ready cards are broad enough to avoid micro-turn churn.
- The next executable card is bounded and testable.
- Desktop scaffolding remains explicitly deferred.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```

## Closeout

Added G01 roadmap `010-server-module-decomposition-and-ipc-readiness.md` and
cards `099` through `104`.

The next executable step is server module decomposition, not UI scaffolding.
