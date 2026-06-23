# 106 Provider Live Read Status Check Smoke

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Use the operator-approved smoke window to run one bounded status/check provider
read and promote only sanitized evidence.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/103-provider-live-read-second-family-selection.md`
- `docs/roadmaps/g03/104-provider-live-read-second-family-stopped-request.md`
- `docs/roadmaps/g03/105-provider-live-read-boundary-stocktake.md`

## Goals

- [x] Confirm a public read-only target with status/check data.
- [x] Run one selected-field `gh pr checks` smoke with operator approval.
- [x] Promote sanitized evidence without retaining raw provider payloads.
- [x] Validate the bounded code/docs lane and keep writes blocked.

## Execution Plan

- [x] Use read-only GitHub CLI discovery with minimal fields.
- [x] Run the approved status/check command with selected JSON fields only.
- [x] Record sanitized evidence summary and any repair gaps.
- [x] Add code support only where it strengthens evidence handling.
- [x] Run focused validation for touched server/docs surfaces.

## Batch Cards

Completed cards:

- `batch-cards/421-provider-live-read-status-check-target.md`
- `batch-cards/422-provider-live-read-status-check-approved-smoke.md`
- `batch-cards/423-provider-live-read-status-check-evidence-promotion.md`
- `batch-cards/424-provider-live-read-status-check-validation.md`

## Acceptance Criteria

- [x] Provider command scope is limited to selected status/check fields.
- [x] No provider write, task mutation, callback, recovery execution, or raw
  payload retention occurs.
- [x] Sanitized evidence states target, selected fields, result category, and
  diagnostics.
- [x] Validation passes or remaining failure is logged as a blocker.

## Smoke Evidence

The approved live smoke used `gh pr checks 13705 -R cli/cli --json
bucket,completedAt,description,event,link,name,startedAt,state,workflow`.

Sanitized result:

- exit code: `0`
- checks: `18`
- pass: `11`
- fail: `0`
- pending: `0`
- skipped: `7`
- cancelled: `0`

Raw provider output is not retained in the repo. See
`docs/logs/2026-06-23-provider-status-check-live-smoke.md`.

## Stop Conditions

- `gh` auth or target discovery requires broad provider data.
- No public target with status/check data can be found using bounded reads.
- The command needs provider writes or task/project mutation.
- Evidence promotion would require retaining raw provider output.
