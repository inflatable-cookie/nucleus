# 190 Compile Local Runtime Backend Implementation Runway

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Compile the next backend implementation runway from the completed discovery
and spawn-gate contracts.

## Scope

- Sequence sandbox, artifact store, event transport, and process-control
  backend work.
- Keep first spawn blocked until all required backends have concrete slices.
- Identify whether god-file splits must happen before implementation.

## Out Of Scope

- Implementing child process spawn.
- Implementing PTY support.
- Desktop UI.

## Promotion Targets

- `docs/roadmaps/g01/032-local-runtime-backend-implementation-runway.md`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Backend implementation order is explicit.
- Each follow-on card has a clear implementation boundary.
- Any refactor prerequisite is named, not left implicit.

## Closeout

- Backend order is artifact store, event transport, sandbox, process control,
  then first read-only spawn.
- Refactor prerequisite is explicit: split oversized server runtime readiness
  modules before adding backend implementation.
- Follow-on backend slices are bounded and keep first spawn blocked until all
  required descriptors are concrete.
