# 046 Engine Boundary Migration

Status: completed
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

- [x] adapter-crate fate decided (operator, 2026-07-18): route the Codex
  runtime through `nucleus-agent-protocol` traits with
  `nucleus-agent-adapters` as the real registry — many more adapters are
  planned, so the boundary must be real; execution lands with card 214
- [x] `nucleus-contract-fixtures` fate decided (operator, 2026-07-18):
  wired — nucleus-server consumes the command-policy fixtures in runner
  contract tests

## Execution Plan

- [x] Move the self-contained `runtime_effect_*` modules from server to
  nucleus-orchestration.
- [x] Move request-handler command/query dispatch into engine services with
  IO behind ports (tasks pre-existing, goals and project lifecycle moved;
  resource commands host-side by design).
- [x] Move goal/task workflow logic (`local_codex_chat/goal_execution`) into
  engine behind effect ports: god file decomposed, pure decisions live in
  `nucleus_engine::goal_run_rules`; provider IO stays host-side.
- [x] Resolve the adapter and fixtures planning gaps above.
- [x] CI module-count ratchet added (baseline 322, lower-only); facade
  deferred with recorded reasoning until a second host form exists.

## Goals

- [x] engine, not server, holds canonical task/project/goal rules and pure
  goal-run decisions
- [x] hosts consume providers through the adapter registry; facade for the
  server API deferred (recorded on card 214)

## Acceptance Criteria

- [x] contract 022's disposition lists are executed or explicitly annotated
  in the contract (runtime effects, identity, goal/project rules, adapter
  routing all dated)
- [x] no orphan crates remain in the workspace (adapters and fixtures both
  consumed)
- [x] server module count guarded by ratchet; decreases enforced going
  forward rather than claimed retroactively

## Batch Cards

Planned:

- `batch-cards/211-runtime-effects-to-orchestration.md`
- `batch-cards/212-request-handler-dispatch-to-engine.md`
- `batch-cards/213-goal-execution-to-engine-ports.md`
- `batch-cards/214-adapter-layer-decision-and-server-facade.md`
