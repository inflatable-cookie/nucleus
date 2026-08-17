# 2026-08-17 Northstar Refresh And Atlas

Status: recorded
Owner: Tom

## Trigger

Northstar skill update. Operator requested project refresh plus long-horizon
Atlas planning with bounded documentation repair.

## Refresh Facet States

| Facet | State | Notes |
| --- | --- | --- |
| Instruction surface | repaired | Added `CLAUDE.md`, `.agents.local.env.example`, contracts 034/035, aligned root `AGENTS.md` |
| Docs spine | repaired | Replaced stale `docs/README.md`; fixed roadmap status drift |
| Architecture and authority | current | No contradictory boundary found beyond known forge gap |
| Planning completeness | repaired | Updated `long-term-plan.md`, `generation-index.md`, proposed `g06/README.md` |
| Currentness and closeout | repaired | Marked `g05/025` completed; batch-card index deduped |
| Validation and distribution | current | Doctor still reports god-file errors; pre-existing, not introduced here |
| Handoffs and papercuts | current | `PAPERCUTS.md` present and usable |

## Repairs Made

- root `CLAUDE.md` with exact `@AGENTS.md` bridge
- `.agents.local.env.example`
- `docs/contracts/034-agent-instruction-surface-contract.md`
- `docs/contracts/035-agent-local-paths-contract.md`
- leaner root `AGENTS.md` with worker-mode boundary and contract pointers
- concise `docs/README.md` current-lane summary
- refreshed `docs/roadmaps/long-term-plan.md` horizon model
- refreshed `docs/roadmaps/generation-index.md` with proposed `g06`
- added `docs/roadmaps/g06/README.md`
- roadmap and contract index updates for orchestration checkpoint state

## Atlas Summary

Destination: Nucleus after g05 shell consolidation and merged orchestration
phases 1-3.

Horizons:

1. `g06` — orchestration live proof and real forge delivery
2. `g07` — deferred workflow-depth returns when product need is proven
3. `g08` — platform hardening and multi-host maturity

Open operator decisions:

- run orchestration checkpoint now or wait for forge provider routes
- whether to design phase-4 worker steering in this generation
- which deferred lane returns first after orchestration proof

## Recommended Next Route

Operator checkpoint for agent orchestration, then compile `g06` batch cards from
`docs/roadmaps/g06/README.md` once checkpoint evidence exists.

Execution is safe to continue for documentation and planning. Production
orchestration proof requires operator action, not more docs-only work.
