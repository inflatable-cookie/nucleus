# 105 Compile Desktop Serialization And Shell Bootstrap Runway

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Compile the next runway for turning the IPC-shaped server boundary into a real
desktop-callable command path.

## Scope

- Add a roadmap for control API wire-envelope implementation.
- Add a roadmap step for Tauri command macro wiring.
- Add a narrow desktop shell bootstrap card only after command wiring is
  testable.
- Keep desktop panels and live subscriptions out of the runway.

## Out Of Scope

- Implementing serialization.
- Scaffolding Tauri.
- Adding UI panels.
- Implementing live subscriptions.

## Promotion Targets

- `docs/roadmaps/g01/README.md`
- `docs/roadmaps/README.md`
- `docs/roadmaps/g01/batch-cards/README.md`

## Acceptance Criteria

- A new G01 roadmap sequences serialization before Tauri command wiring.
- Desktop scaffold work is bounded to shell bootstrap only.
- Panel work remains deferred.
- The next executable card is bounded and testable.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```

## Closeout

Added G01 roadmap `011-desktop-serialization-and-shell-bootstrap.md` and cards
`106` through `110`.

The next executable step is naming the control API wire format and codec
boundary before any Tauri shell scaffold.
