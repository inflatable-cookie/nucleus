# 098 Orchestration Run Registry And Persistence

Status: planned
Owner: Tom
Created: 2026-08-13
Milestone: none yet (agent orchestration lane, phase 1)
Depends on: contract 033 (draft); translation memo
  `docs/research/translation-memos/agent-orchestration-lane.md`
Auto-start next card: no

## Objective

Introduce the orchestration run aggregate in nucleus-server: the durable run
record, its lifecycle commands and events on the contract-018 spine, and the
projections the desktop will render. No UI, no delegation tools, no
orchestrator agent — operator-facing flows arrive in 099-101.

## Governing Refs

- `docs/contracts/033-orchestration-runs-and-delegation-authority-contract.md`
  (draft) — Run Record Rule, lifecycle states, Audit Rule
- `docs/contracts/018-orchestration-contract.md` — command/event/projection/
  receipt spine the aggregate must ride
- `docs/contracts/020-runtime-receipt-contract.md` — side-effect receipts
- `docs/research/translation-memos/agent-orchestration-lane.md` —
  architecture position and 2026-08-13 decisions

## Scope (planned)

- Run record: id, project, objective (scope, acceptance, stop conditions),
  worktree identity, provider instance + model, orchestrator designation
  (nullable in phase 1 — operator-dispatched runs have none), operation and
  conversation ids, lifecycle state, budget envelope, closeout slot.
- Lifecycle: `proposed → dispatched → running → delivered → accepted |
  rejected | failed | cancelled`; transitions are commands with events and
  receipts; invalid transitions rejected.
- Persistence + projection query for the fleet view (list runs by project
  with state, provider, recency).
- Validation: state-machine fixtures, persistence round-trip, projection
  shape tests.

Out of scope: worktree creation, conversation spawn, delegation tools, UI,
delivery pipeline.

## Acceptance (planned)

- [ ] run aggregate persists and round-trips; lifecycle transitions enforced
- [ ] fleet projection query returns the contract-033 shape
- [ ] receipts emitted for every transition; audit trail readable
- [ ] server test suite green; batch log

## Stop Conditions

- The aggregate cannot ride the 018 spine without envelope changes → stop
  with citations
- Contract 033's lifecycle set proves insufficient for a real transition →
  stop and propose the amendment
