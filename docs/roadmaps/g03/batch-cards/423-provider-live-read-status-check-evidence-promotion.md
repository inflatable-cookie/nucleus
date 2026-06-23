# 423 Provider Live Read Status Check Evidence Promotion

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../106-provider-live-read-status-check-smoke.md`

## Purpose

Promote the approved smoke into sanitized evidence and diagnostics.

## Governing Refs

- `../106-provider-live-read-status-check-smoke.md`
- `docs/contracts/027-provider-auth-forge-execution-contract.md`

## Acceptance Criteria

- [x] Evidence records retain selected fields, target, counts, exit category,
  and guardrail diagnostics only.
- [x] Raw provider stdout, stderr, headers, request body, response body, and
  payload data remain excluded.
- [x] Repair blockers cover missing evidence, write/task mutation, raw payload
  retention, and non-selected command scope.
- [x] Focused tests cover promoted and blocked evidence paths.

## Result

Added `ProviderLiveReadStatusCheckSmokeEvidenceRecord` and diagnostics for
sanitized status/check smoke evidence.

## Stop Conditions

- Evidence model starts acting as generalized status/check ingestion.
- Evidence promotion requires raw provider payload retention.
