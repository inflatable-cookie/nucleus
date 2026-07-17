# 046 Engine Boundary Migration

Status: planned
Owner: Tom
Updated: 2026-07-17

## Purpose

Execute contract 022's standing migration list so canonical business rules
move from nucleus-server into nucleus-engine and nucleus-orchestration, and
decide the fate of the dead adapter layer.

Audit basis: `../../logs/2026-07-17-codebase-audit-findings.md` (server holds
~87% of workspace code; contract 022 disposition never executed;
nucleus-agent-adapters and nucleus-contract-fixtures are orphans; Codex is
hardcoded into the server).

## Governing Refs

- `../../contracts/022-engine-orchestration-boundary-contract.md`
- `../../contracts/002-harness-adapter-contract.md`
- `../../contracts/009-adapter-registry-contract.md`

## Planning Gaps

- [ ] decide adapter-crate fate: route the Codex runtime through
  `nucleus-agent-protocol` traits and a real registry, or delete
  `nucleus-agent-adapters` and record "Codex-only, in-server, for now" in
  architecture
- [ ] decide `nucleus-contract-fixtures` fate: wire into tests or delete

## Execution Plan

- [ ] Move the self-contained `runtime_effect_*` modules from server to
  nucleus-orchestration.
- [ ] Move request-handler command/query dispatch into engine services with
  IO behind ports.
- [ ] Move goal/task workflow logic (`local_codex_chat/goal_execution`) into
  engine behind effect ports.
- [ ] Resolve the adapter and fixtures planning gaps above.
- [ ] Add a facade module for the server public API and stop flat
  re-exporting internals; add a CI guard so server module count trends down.

## Goals

- [ ] engine, not server, holds canonical task/project/session rules
- [ ] desktop and nucleusd consume engine services through the facade

## Acceptance Criteria

- [ ] contract 022's "move toward engine/orchestration" lists are executed or
  explicitly amended in the contract
- [ ] nucleusd imports engine services for at least the migrated paths
- [ ] no orphan crates remain in the workspace
- [ ] server line/module count decreases across the lane

## Batch Cards

Planned:

- `batch-cards/211-runtime-effects-to-orchestration.md`
- `batch-cards/212-request-handler-dispatch-to-engine.md`
- `batch-cards/213-goal-execution-to-engine-ports.md`
- `batch-cards/214-adapter-layer-decision-and-server-facade.md`
