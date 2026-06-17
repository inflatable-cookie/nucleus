# 187 Compose Discovery Output With Host Spawn Gate

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Feed local host runtime discovery output into the host-spawn readiness gate.

## Scope

- Add a composition helper or fixture path from discovery output to gate input.
- Preserve explicit project, authority, supervisor, and interruption inputs.
- Prove unsupported discovery keeps spawn blocked.

## Out Of Scope

- Real process spawning.
- Real sandbox execution.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Host-spawn gate accepts descriptor values sourced from discovery output.
- Unsupported discovery produces concrete backend blockers.
- Tests cover the non-spawning composition path.

## Closeout

- Added `LocalHostRuntimeDiscoveryGateInput`.
- Added `evaluate_host_spawn_readiness_from_discovery`.
- Test proves unsupported discovery feeds the spawn gate and returns concrete
  backend blockers without spawning.
