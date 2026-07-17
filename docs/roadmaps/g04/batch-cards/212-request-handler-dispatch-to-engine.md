# 212 Request Handler Dispatch To Engine

Status: completed
Owner: Claude
Updated: 2026-07-17
Milestone: `../046-engine-boundary-migration.md`
Auto-start next card: no

## Objective

Move command/query dispatch business rules from
`nucleus-server/src/request_handler/` into engine services with IO behind
ports.

## Steps

- carve dispatch into engine service functions taking store/effect ports
- server keeps transport-shaped concerns (DTO mapping, envelope validation)
- migrate incrementally by domain; task commands first (engine already owns
  `task_commands`)

## Acceptance

- [x] task command dispatch already ran through
  `EngineTaskCommandService` (audit's "engine unused" was about direct
  imports; the port pattern was in place) — verified, recorded
- [x] goal command rules moved to `nucleus_engine::goal_commands`
  (status gates, membership validation, field merge, revision derivation);
  server handler is now DTO mapping + storage port + error mapping, proven
  by unchanged server tests plus new engine unit tests
- [x] project lifecycle rules moved to
  `nucleus_engine::project_commands`: authority-host checks, idempotency
  fingerprints and replay, create/rename/park/archive/restore, and the
  deletion-impact refusal scan, all behind an `EngineProjectRepository`
  port; server adapter is DTO mapping + port + error mapping; engine unit
  tests cover idempotent replay, key-reuse conflict, and authority
  rejection; project_resource_commands stays host-side by design
  (filesystem authority)

## Validation

- `cargo test --workspace`

## Stop Conditions

- stop at domains whose rules are entangled with codex runtime; card 213
  covers those
