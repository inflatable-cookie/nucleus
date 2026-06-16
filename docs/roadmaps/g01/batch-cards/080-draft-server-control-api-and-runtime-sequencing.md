# 080 Draft Server Control API And Runtime Sequencing

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Choose the next implementation runway after the local storage slice.

## Scope

- Reassess API, auth, Tauri, and runtime scheduler ordering.
- Decide whether the next lane should implement UI, provider runtime, command
  execution, auth, or server control API.
- Create the governing roadmap and next ready cards.
- Keep the reassessment inside `g01`.

## Out Of Scope

- Implementing server API code.
- Building Tauri UI.
- Adding network transport.
- Adding runtime scheduler execution.
- Adding command execution.

## Evidence Questions

- What depends directly on the new storage substrate?
- What must exist before Tauri can be a real client?
- What must exist before runtime scheduler execution is safe?
- Which auth work is needed before local client development?
- Which decisions can stay deferred until transport selection?

## Promotion Targets

- `docs/roadmaps/g01/006-server-local-state-implementation-runway.md`
- `docs/roadmaps/g01/007-server-control-api-and-runtime-sequencing.md`
- `docs/roadmaps/g01/batch-cards/README.md`
- `docs/roadmaps/README.md`

## Decisions

- The next lane is server control API and runtime sequencing.
- The first server API should be local Rust command/query/service types, not a
  network transport.
- Tauri stays deferred until it can consume server-owned state through the
  local boundary.
- Runtime scheduling stays deferred until command authority and event replay
  boundaries exist.
- Remote auth and pairing stay deferred; local readiness vocabulary is enough
  for the next slice.

## Closeout

Created roadmap `007-server-control-api-and-runtime-sequencing.md` and made
`081-add-local-server-state-service-facade.md` the next ready card.
