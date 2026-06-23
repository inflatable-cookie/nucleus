# 105 Provider Live Read Boundary Stocktake

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Pause after the persisted evidence and second-family stopped-request runway to
check whether provider work is still the right g03 lane.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/architecture/architecture-gap-index.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Summarize what provider live-read work now proves.
- [x] Identify remaining gaps and overbuild risks.
- [x] Decide whether to continue provider work, return to task/project flows,
  or move toward a UI/server integration slice.

## Execution Plan

- [x] Review completed g03 provider live-read milestones.
- [x] Refresh architecture and implementation gap indexes.
- [x] Update roadmap next-task pointer.
- [x] Validate docs and doctor state.

## Batch Cards

Completed cards:

- `batch-cards/417-provider-live-read-boundary-stocktake.md`
- `batch-cards/418-provider-live-read-gap-index-refresh.md`
- `batch-cards/419-provider-live-read-next-lane-decision.md`
- `batch-cards/420-provider-live-read-stocktake-validation.md`

## Acceptance Criteria

- [x] Current provider live-read capability is accurately summarized.
- [x] Next lane is deliberate, not momentum-driven.
- [x] Docs QA and Northstar QA pass.

## Stocktake

Provider live-read now proves:

- fixture-backed admission, preflight, request planning, persistence, and
  diagnostics
- selected-field manual GitHub CLI evidence promotion
- persisted approved smoke evidence records
- explicit local replay with duplicate noops
- state-backed diagnostics and provider-readiness source counts
- a selected second family, status/check refresh
- stopped status/check target, authority checklist, request, and diagnostics
  records

Still blocked:

- automatic provider command execution
- live status/check command execution
- provider writes and review actions
- credential material resolution or storage
- raw stdout/stderr, headers, request body, response body, or provider payload
  retention
- task mutation, callbacks, interruption, or recovery execution
- UI-triggered provider reads

Decision:

- stop provider live-read execution momentum here.
- next major lane should shift back toward task/project workflow value unless
  the operator explicitly approves a status/check live smoke.
- use the next planning step to select between task/project workflow depth,
  server/client workflow hardening, or an explicitly approved status/check live
  read.
