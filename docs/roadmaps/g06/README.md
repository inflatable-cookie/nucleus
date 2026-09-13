# g06 Orchestration Proof And Forge Reality

Status: proposed
Owner: Tom
Updated: 2026-08-17

## Purpose

Turn merged orchestration surfaces into trustworthy daily use: live operator
checkpoint, contract 033 promotion, real forge delivery routes, and optional
worker steering only if the operator selects it.

## Preconditions

- g05 agent orchestration phases 1-3 remain merged on main
- operator completes the live checkpoint described in
  `docs/roadmaps/README.md`
- any forge provider route work stays inside contract 027 authority

## Proposed Runway Bands

1. operator live checkpoint and contract 033 promotion evidence
2. real forge provider routes for orchestrated delivery
3. optional phase-4 worker steering (`message_run`) if selected
4. two-worker multi-provider proof before widening automation

## Non-Goals

- agent-initiated merge authority
- provider-native child steering without evidence
- resuming deferred lanes before a visible product workflow needs them

## Canonical Refs

- `../long-term-plan.md`
- `../generation-index.md`
- `../../research/translation-memos/agent-orchestration-lane.md`
- `../../contracts/033-orchestration-runs-and-delegation-authority-contract.md`
- `../../contracts/027-provider-auth-forge-execution-contract.md`

Do not open g06 task files here until the operator checkpoint closes and the
first band is selected.

## Queue lifecycle adoption

- [g06.001 Effigy-hosted lifecycle hook](001-adopt-effigy-hosted-lifecycle-hook.md)
  is an operator-approved, configuration-only maintenance lane. It follows its
  declared Queue dependencies and may run without changing product priority.
  Existing next-task text continues to describe product sequencing; this entry
  authorizes no sibling product work.
<!-- northstar:lifecycle:begin schema=northstar.lifecycle.projection.v2 digest=sha256:7a223569d0d4216763c61b9b6c01b1b8c3c1f518801a3403836e35098986565d -->
| Generation | Disposition | Runway state |
| --- | --- | --- |
| g06 | open | planning_required |
| Task | Status | Stage | Revision | Record digest |
| --- | --- | --- | --- | --- |
| g06.001 | complete | none | 8 | sha256:6fe5c4a39d04302298dc0ee8cdb13757e88d7391f78eea63ebd0c5697ccdae74 |
<!-- northstar:lifecycle:end -->
