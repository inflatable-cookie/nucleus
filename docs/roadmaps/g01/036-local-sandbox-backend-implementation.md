# 036 Local Sandbox Backend Implementation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Implement the first local sandbox backend slice for a read-only command spawn
runway.

## Scope

- Add local sandbox backend implementation boundary.
- Select the first enforceable local sandbox profile.
- Preserve unsupported and advisory-only states explicitly.
- Compose sandbox readiness into local runtime discovery.
- Keep process spawn out of scope.

## Out Of Scope

- Process spawn.
- Shell passthrough.
- PTY or terminal rendering.
- Remote sandboxing.
- Platform-specific hardening beyond the first named local slice.

## Decisions

- Sandbox follows artifact store and event transport because execution evidence
  and event delivery now have first local readiness slices.
- Unsupported platforms must stay unsupported, not silently degrade to ready.
- Advisory-only sandbox posture is not enough for host-spawn readiness.
- The first enforceable profile should be narrow and read-only.

## Execution Plan

- [x] Add local sandbox backend boundary.
- [x] Define first enforceable read-only sandbox profile.
- [x] Add sandbox readiness discovery.
- [x] Compose sandbox readiness with runtime discovery.
- [x] Reassess process-control backend implementation readiness.

## Closeout

The first local sandbox backend slice is implemented in `nucleus-server`.

Implemented surface:

- `LocalSandboxBackend`
- `LocalSandboxBackendId`
- `LocalSandboxBackendPosture`
- `LocalSandboxBackendPlatform`
- `LocalSandboxProfileSupport`
- `with_local_sandbox_readiness`

The backend can report concrete readiness for `NoFilesystemWrite` with
enforcement evidence. Unsupported and advisory-only postures remain visible
blockers and do not satisfy host-spawn readiness.

Runtime discovery can now replace the unsupported sandbox descriptor with
concrete local readiness. With artifact store, event transport, and sandbox
readiness composed, host-spawn readiness still remains blocked by
process-control descriptors.

The next lane is local process-control backend implementation.

## Acceptance Criteria

- Sandbox readiness can be concrete without process spawn.
- `NoFilesystemWrite` is the first target profile.
- Unsupported and advisory-only posture remain visible blockers.
- Host-spawn readiness remains blocked by process-control descriptors.

## Cards

- `docs/roadmaps/g01/batch-cards/211-add-local-sandbox-backend-boundary.md`
- `docs/roadmaps/g01/batch-cards/212-define-read-only-sandbox-profile.md`
- `docs/roadmaps/g01/batch-cards/213-add-sandbox-readiness-discovery.md`
- `docs/roadmaps/g01/batch-cards/214-compose-sandbox-readiness-with-runtime-discovery.md`
- `docs/roadmaps/g01/batch-cards/215-reassess-process-control-backend-readiness.md`
