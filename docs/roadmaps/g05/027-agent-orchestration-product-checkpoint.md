# 027 Agent Orchestration Product Checkpoint

Status: paused (operator live checkpoint pending)
Owner: Tom
Created: 2026-09-09

## Purpose

Turn the merged agent orchestration phases 1–3 into trustworthy daily use.
The machinery is on `main`; it has never run under a designated orchestrator
on a real project with a delegated delivery reviewed to closeout.

## Governing Refs

- `../../contracts/033-orchestration-runs-and-delegation-authority-contract.md` (draft — stays draft until this checkpoint)
- `../../research/translation-memos/agent-orchestration-lane.md`
- `../../contracts/005-task-contract.md`
- `../../contracts/020-runtime-receipt-contract.md`

## Generation Runway Goal

Prove one orchestrated delivery loop — dispatch, run, deliver, review —
before any phase-4 steering or wider automation is selected.

## Completed Foundation

Phases 1–3 merged on `main`, collapsed from batch cards by the
flattened-task migration (2026-09-09). Dispatch and merge evidence lives in
`../dispatch.md`, with per-card implementation logs under `../../logs/`.

- Phase 1: run registry and persistence (`098`, merged `94028b31`),
  worktree-creation authority (`105`, merged `d85adc4d`),
  operator-dispatched runs (`099`, merged `2644ead9`), fleet panel (`100`),
  delivery pipeline (`101`, merged `bbe74b7e`), delivery commit and push
  authority (`106`, merged `0034ad9c`).
- Phase 2: delivery review surface (`102`), forge pull-request lane
  (`103`), forge PR-creation authority (`107`, merged `c1927e31`).
- Phase 3: orchestrator designation and delegation tools (`104`).
- Real forge routes still report `ProviderUnavailable` until a provider
  `027` lane lands; that is expected, not a failure of this checkpoint.

## Goals

- [ ] designate an orchestrator on a real project
- [ ] review one delegated delivery to closeout
- [ ] promote or amend contract 033 on the checkpoint evidence
- [ ] select or defer the g06 first band on the checkpoint outcome

## Acceptance Criteria

- [ ] one run is dispatched by the designated orchestrator, not ad hoc
- [ ] the run reaches `delivered` with closeout, validation, and receipts
- [ ] the operator reviews the delivery through the phase-2 review surface
- [ ] contract 033 stays draft or is promoted — never silently treated as final
- [ ] no agent-initiated merge authority is assumed

## Resume Condition

The operator selects a real project and authorizes the live checkpoint run.

## Stop Conditions

- provider-native child steering without evidence is out of scope
- phase-4 worker steering (`message_run`) starts only if the operator selects it
- resuming deferred lanes before this checkpoint closes is out of scope
