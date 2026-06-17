# 185 Add Local Host Runtime Discovery Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add vocabulary for non-spawning local host runtime capability discovery.

## Scope

- Name the local host discovery surface.
- Name discovery status values.
- Name discovered backend descriptor groups.
- Keep discovery separate from backend implementation.

## Out Of Scope

- Child process spawning.
- OS sandbox enforcement.
- Artifact payload storage.
- Event publishing.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Discovery vocabulary compiles.
- Discovery output can carry sandbox, artifact store, event transport, and
  process-control readiness descriptors.
- Discovery types do not perform IO or spawn work.
- Tests prove unsupported discovery can be represented.

## Closeout

- Added `LocalHostRuntimeDiscovery`,
  `LocalHostRuntimeDiscoveryStatus`,
  `LocalHostRuntimeDiscoveryFinding`, and
  `LocalHostRuntimeDiscoveryEvidenceRef`.
- Discovery output carries sandbox, artifact store, event transport, and
  process-control readiness descriptors.
- Tests cover unsupported discovery, descriptor host mismatch findings, and a
  ready descriptor group without IO or spawn behavior.
