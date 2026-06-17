# Engine Orchestration Boundary

Status: draft
Owner: Tom
Updated: 2026-06-17

## Purpose

Summarize the selected crate shape for `g02`.

Durable rules live in
`docs/contracts/022-engine-orchestration-boundary-contract.md`.

## Selected Shape

Nucleus gets two new core crates:

- `nucleus-orchestration`
- `nucleus-engine`

`nucleus-orchestration` is the event-sourced mechanics crate.

`nucleus-engine` is the portable domain execution crate.

`nucleus-server` becomes a host wrapper and API boundary. It should stop
accumulating canonical domain behavior.

## Why Two Crates

A single `nucleus-engine` crate would be simpler short-term, but would blur
two different responsibilities:

- orchestration mechanics: commands, events, replay, projections, receipts
- product domain execution: projects, tasks, sessions, policy, authority,
  effect admission

Separating them keeps the event model testable without pulling in every domain
crate. It also lets engine code compose orchestration without owning low-level
event vocabulary.

## First Migration Slice

The first code migration was intentionally small:

- create crate skeletons
- add minimal module fronts
- keep `lib.rs` as indexes
- split the blocking command-policy storage codec god-file
- route project/task/workspace state-record queries through
  `nucleus-engine::EngineReadModelService`

Do not migrate provider runtime, SCM mutation, remote transport, or UI panels
as part of the next slice.

The first `g02` migration slice is complete:

- command admission for task commands routes through `nucleus-orchestration`
  before existing task mutation handling
- admitted task commands append a command-admitted event-journal record before
  mutation
- command-admission projections can rebuild from orchestration event records in
  the server event journal

The next milestone is event-store persistence hardening. It should improve the
event store record boundary, repository interface, replay integrity, and
validation coverage without broadening provider runtime, SCM mutation, remote
transport, or UI behavior.

## Current Pressure

`nucleus-server` currently contains:

- host API and DTOs
- Tauri IPC boundary
- local transport fixtures
- local process/read-only spawn paths
- runtime readiness diagnostics
- command evidence
- state services
- scheduler and runtime-effect vocabulary
- project/task seed fixtures

That mix was acceptable during foundation work. It is now the main boundary
pressure for `g02`.
