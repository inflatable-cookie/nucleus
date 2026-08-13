# 102 Run Delivery Review Surface

Status: planned
Owner: Tom
Created: 2026-08-13
Milestone: none yet (agent orchestration lane, phase 2)
Depends on: 101 (run delivery pipeline)
Auto-start next card: no

## Objective

Give the operator a proper review surface for delivered runs: the closeout
(summary + evidence + validation result) beside the run's diff, with
accept/reject and jump-into-editor actions. Phase 1 landed accept/reject as
registry transitions with review riding the generic diff flow; this card
makes review a first-class run experience.

## Governing Refs

- Contract 033 (draft) — Delivery Rule (acceptance is a separate act) and
  Audit Rule
- Cards 063-066 — review workflow contract, exact diff-to-editor
  navigation, rework handoff: reuse, do not parallel-build
- `docs/research/source-hubs/harness-agent-orchestration.md` — the
  delivery-review convergence (closeout + diff + decision)

## Scope (planned)

- Desktop delivery review: opening a `delivered` run shows the closeout,
  validation result, and the run branch's diff against the base; accept /
  reject actions transition the registry; rework needs route through the
  existing review-to-agent handoff.
- If the composition proves repetitive, a poodle component candidate
  (delivery-review surface) is a batch-log finding, not this card's work.
- Fixtures for review rendering and both dispositions.

Out of scope: PR creation (103), orchestrator-side review (phase 3), merge
automation.

## Acceptance (planned)

- [ ] delivered run renders closeout + validation + diff in one surface
- [ ] accept/reject from the surface transitions the registry with receipts
- [ ] rework routes through the existing 063-066 handoff
- [ ] fixtures + desktop suites green; batch log

## Stop Conditions

- The 063-066 review workflow cannot host run-branch diffs without contract
  changes → stop with citations
