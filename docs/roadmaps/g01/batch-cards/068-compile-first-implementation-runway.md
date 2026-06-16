# 068 Compile First Implementation Runway

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Compile the first implementation runway inside `g01`.

## Scope

- Choose the first implementation slice.
- Define success criteria, stop conditions, and validation for that slice.
- Create or update the roadmap file that will govern implementation batches.
- Create a visible runway of several meaningful implementation cards.
- Keep command execution, provider adapters, Tauri behavior, remote auth,
  secret backend implementation, and artifact payload storage out unless
  explicitly selected.

## Out Of Scope

- Writing implementation code.
- Opening a new generation.
- Selecting every future backend.
- Building Tauri UI.
- Implementing live harness adapters.

## Evidence Questions

- Which implementation slice gives the strongest foundation with the least
  runtime risk?
- Should the first slice start with server-local project/task/storage state,
  adapter registry persistence, or runtime effect storage?
- What must be tested before later command or adapter runtime work can start?
- Which decisions can stay deferred until the owning subsystem begins?

## Stop Conditions

- The runway starts implementation.
- The runway depends on unresolved provider, Tauri, command-runner, or remote
  auth behavior.
- The runway becomes a one-card micro-plan.
- A new generation is opened.

## Promotion Targets

- `docs/roadmaps/g01/005-server-runtime-boundaries.md`
- a new or updated `docs/roadmaps/g01/006-*.md` implementation roadmap
- `docs/roadmaps/g01/batch-cards/README.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```
