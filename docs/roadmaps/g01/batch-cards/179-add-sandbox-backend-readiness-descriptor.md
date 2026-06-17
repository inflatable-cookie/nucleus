# 179 Add Sandbox Backend Readiness Descriptor

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add a typed sandbox backend readiness descriptor for host-spawn gating.

## Scope

- Name sandbox backend kind.
- Name enforced sandbox profiles.
- Capture enforcement evidence refs.
- Keep advisory-only backends blocked.

## Out Of Scope

- Implementing an OS sandbox.
- Child process spawning.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Sandbox readiness is typed.
- Advisory-only sandbox readiness blocks spawn.
- Descriptor carries evidence refs without backend implementation.

## Closeout

- Added `SandboxBackendReadiness`, `SandboxBackendKind`, and
  `SandboxBackendEvidenceRef`.
- Descriptor names backend kind, enforced profiles, enforcement posture, and
  evidence refs.
- Tests prove advisory-only readiness and missing evidence do not support
  future spawn.
