# 101 Provider Live Read Smoke Evidence Seed Replay

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Add an explicit replay/seed path for the approved `octocat/Hello-World`
provider live-read smoke evidence.

This lane should make the historical approved smoke available to local state
without hiding fixture evidence inside read queries.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/logs/2026-06-22-provider-live-read-smoke-evidence.md`
- `docs/roadmaps/g03/100-provider-live-read-smoke-evidence-state-backed-query.md`

## Goals

- [x] Add a named seed/replay function for the approved smoke evidence.
- [x] Persist the promoted selected-field record through the g03/099
  persistence path.
- [x] Add a `nucleusd`/Effigy inspection or seed surface only if it remains
  read-only and explicit.
- [x] Keep live provider execution blocked.

## Execution Plan

- [x] Define the replay input and historical evidence builder.
- [x] Persist replay output with duplicate-noop behavior.
- [x] Add a narrow CLI/Effigy surface if useful for local proof.
- [x] Validate query output against seeded state.

## Batch Cards

Completed cards:

- `batch-cards/401-provider-live-read-smoke-evidence-replay-builder.md`
- `batch-cards/402-provider-live-read-smoke-evidence-replay-persistence.md`
- `batch-cards/403-provider-live-read-smoke-evidence-replay-cli-effigy.md`
- `batch-cards/404-provider-live-read-smoke-evidence-replay-validation.md`

## Acceptance Criteria

- [x] Historical approved smoke evidence can be written explicitly.
- [x] Replay is idempotent and duplicate-safe.
- [x] Replay does not call providers or resolve credentials.
- [x] State-backed query observes replayed evidence.

## Current Slice

Completed:

- added server replay for the approved selected-field `octocat/Hello-World`
  smoke evidence.
- added `nucleusd provider-live-read-smoke-evidence replay-approved`.
- added Effigy selector
  `server:provider-live-read-smoke-evidence:replay-approved`.
- validated first replay, duplicate replay, and state-backed query output
  against an isolated target SQLite file.
