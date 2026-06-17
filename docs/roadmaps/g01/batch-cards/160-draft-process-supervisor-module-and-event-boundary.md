# 160 Draft Process Supervisor Module And Event Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Draft the boundary for a process supervisor module and its event publication
shape before implementation.

## Scope

- Separate command authority from process supervision.
- Define supervision event categories.
- Keep event payloads evidence-ref based.
- Keep sandbox blockers visible.
- Require execution authority from the project authority map before supervisor
  acceptance.

## Out Of Scope

- Child process spawning.
- Runtime event transport.
- Raw output artifacts.
- Desktop UI.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Process supervisor responsibilities are explicit.
- Event publication shape is explicit.
- No child process spawning is introduced.

## Closeout

- Added process supervisor module and event boundary to the server boundary
  contract.
- Supervisor acceptance must check execution authority before accepting work.
- Events are evidence-ref based and raw-output free.
