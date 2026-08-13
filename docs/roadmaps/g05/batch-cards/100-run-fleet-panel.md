# 100 Run Fleet Panel

Status: completed
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

- [x] fleet panel lists runs with state, provider, recency; grouped by
  lifecycle
- [x] run → worker thread navigation works for live and terminal runs
- [x] failed/detached runs render honestly with receipt reason
- [x] fixtures + `effigy desktop:check` + `effigy desktop:test` pass; batch
  log

## Closeout

Merged to main as `18ff85be` (worker commit `45bce8f9`, Luna-high, clean
first run). A Runs tab in the workspace sidebar renders the fleet
projection grouped by lifecycle with provider/model/recency and degraded
failure truth; opening a run navigates to its deterministic worker
conversation. Composed from existing poodle primitives — no component
candidate needed. Main verification: check clean, 71 bun + 30 vitest pass;
the single vitest failure is the pre-existing settingsDialog tabindex
drift from the longhorn sweep, documented in the batch log.

## Stop Conditions

- Existing poodle primitives cannot express the board without new
  components → stop with the proposed component contract sketch
