# 214 Adapter Layer Decision And Server Facade

Status: planned
Owner: Codex
Updated: 2026-07-17
Milestone: `../046-engine-boundary-migration.md`
Auto-start next card: no

## Objective

Resolve the orphan-crate planning gaps and give nucleus-server a deliberate
public facade.

## Steps

- operator decision: route codex runtime through `nucleus-agent-protocol`
  traits with `nucleus-agent-adapters` as the real registry, or delete the
  orphan crate and record Codex-only posture in architecture
- decide `nucleus-contract-fixtures`: wire into tests or delete
- add a server facade module (control DTOs + handler entry points); stop
  flat re-exporting ~290 internals from the crate root
- add CI guard tracking server module count downward

## Acceptance

- [ ] no orphan crates; docs match reality
- [ ] consumers import through the facade only
- [ ] module-count guard active in CI

## Validation

- `cargo test --workspace`
- CI green with guard

## Stop Conditions

- stop before implementing a second provider adapter; that is a future lane
