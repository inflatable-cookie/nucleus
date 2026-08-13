# 100 Run Fleet Panel

Status: dispatched
Owner: Tom
Created: 2026-08-13
Milestone: none yet (agent orchestration lane, phase 1)
Depends on: 098 (run registry), 099 (operator-dispatched runs)
Auto-start next card: no

## Objective

Render the run registry as a fleet panel: every run with its state,
provider/model, budget burn, and recency; opening a run navigates to its
worker thread. The cross-product evidence (Mission Control, Agent Command
Center) converges on this status-board-plus-thread shape.

## Governing Refs

- `docs/research/source-hubs/harness-agent-orchestration.md` — the fleet UX
  synthesis (board + per-run thread; honest degraded truth)
- Contract 033 (draft) — fleet projection renders from receipts
- Card 096 (message centre) — the panel composition precedent
- `docs/contracts/019-conversation-timeline-contract.md` — run rows link
  into real conversations

## Scope (planned)

- Desktop fleet panel (sidebar or panel region per the workspace
  conventions): run rows with state badge, objective title, provider/model,
  budget burn where available, relative time; grouped by lifecycle
  (active / delivered / terminal).
- Row click opens the run's worker conversation as an ordinary thread;
  terminal runs remain inspectable.
- Degraded truth: a run whose operation died or detached renders `failed`
  with its receipt reason; no silent disappearance.
- Compose from existing poodle primitives. If the shape proves repetitive,
  note a candidate poodle `RunCard`/`FleetBoard` component in the batch log
  as a poodle-side candidate card — do not build it here.
- Fixtures for grouping, state rendering, degraded truth, navigation.

Out of scope: delivery review actions (101), orchestrator affordances,
poodle source changes.

## Acceptance (planned)

- [ ] fleet panel lists runs with state, provider, recency; grouped by
  lifecycle
- [ ] run → worker thread navigation works for live and terminal runs
- [ ] failed/detached runs render honestly with receipt reason
- [ ] fixtures + `effigy desktop:check` + `effigy desktop:test` pass; batch
  log

## Stop Conditions

- Existing poodle primitives cannot express the board without new
  components → stop with the proposed component contract sketch
