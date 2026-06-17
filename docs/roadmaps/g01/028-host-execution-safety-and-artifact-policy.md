# 028 Host Execution Safety And Artifact Policy

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the safety and artifact boundaries needed before any real local
read-only host-spawn implementation.

## Scope

- Define honest local host sandbox enforcement posture.
- Define first command artifact payload and retention policy.
- Define timeout and cancellation implementation contract.
- Reassess whether a first read-only host-spawn slice is ready.

## Out Of Scope

- Child process spawning.
- PTY streaming.
- Desktop UI.
- Network, secret, destructive, SCM mutation, or provider lifecycle commands.

## Decisions

- Process supervisor events and acceptance are not enough to start spawning
  processes.
- `NoFilesystemWrite` and `ProjectRestricted` must not be presented as
  enforced unless the host can prove enforcement.
- Raw stdout/stderr payloads require an artifact policy before they can be
  retained.

## Execution Plan

- [x] Draft local host execution safety strategy.
- [x] Define command artifact payload retention policy.
- [x] Define timeout and cancellation implementation contract.
- [x] Reassess read-only host-spawn readiness.

## Acceptance Criteria

- [x] Sandbox posture is honest and implementation-shaped.
- [x] Artifact payload retention has a separate policy boundary.
- [x] Timeout and cancellation behavior is named before spawn.
- [x] Host-spawn readiness remains explicit.

## Cards

- `docs/roadmaps/g01/batch-cards/171-draft-local-host-execution-safety-strategy.md`
- `docs/roadmaps/g01/batch-cards/172-define-command-artifact-payload-retention-policy.md`
- `docs/roadmaps/g01/batch-cards/173-define-timeout-and-cancellation-implementation-contract.md`
- `docs/roadmaps/g01/batch-cards/174-reassess-read-only-host-spawn-readiness.md`
