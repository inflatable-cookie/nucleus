# 212 Request Handler Dispatch To Engine

Status: planned
Owner: Codex
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

- [ ] task command and query dispatch runs through engine services
- [ ] nucleusd exercises engine paths for migrated domains
- [ ] no business-rule branches remain server-side for migrated domains

## Validation

- `cargo test --workspace`

## Stop Conditions

- stop at domains whose rules are entangled with codex runtime; card 213
  covers those
