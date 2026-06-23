# 100 Provider Live Read Smoke Evidence State-Backed Query

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Connect provider live-read smoke evidence diagnostics to persisted local-store
records.

This lane removes the implicit fixture-backed diagnostics path from the control
query. Empty state should report no persisted evidence. Seeded or persisted
state should report only sanitized selected-field evidence already stored by
the server.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/099-provider-live-read-approved-smoke-evidence-persistence.md`

## Goals

- [x] Read approved smoke evidence diagnostics from persisted local-store
  records.
- [x] Keep fresh empty state explicit as zero records.
- [x] Preserve the no-effect query boundary.
- [x] Add focused tests for empty and seeded persisted states.

## Execution Plan

- [x] Replace the fixture-only diagnostics composer with a state-backed query.
- [x] Route request-handler smoke evidence queries through handler state.
- [x] Add server tests for empty and persisted evidence states.
- [x] Validate the focused provider live-read query slice.

## Batch Cards

Completed cards:

- `batch-cards/397-provider-live-read-smoke-evidence-state-query-composer.md`
- `batch-cards/398-provider-live-read-smoke-evidence-handler-state-route.md`
- `batch-cards/399-provider-live-read-smoke-evidence-state-query-tests.md`
- `batch-cards/400-provider-live-read-smoke-evidence-state-query-validation.md`

## Acceptance Criteria

- [x] Query diagnostics come from persisted approved smoke evidence records.
- [x] Empty state returns zero evidence records.
- [x] Seeded persisted state returns promoted smoke evidence diagnostics.
- [x] Query execution does not run provider commands or resolve credentials.

## Current Slice

Completed:

- smoke evidence diagnostics now read from persisted approved evidence records.
- empty state returns zero records; seeded persisted state returns promoted
  diagnostics.
- the next lane is explicit seed/replay, not hidden fixture fallback.

## Stop Conditions

- Stop before automatic provider command execution.
- Stop before UI-triggered provider reads.
- Stop before provider writes, task mutation, callback, interruption, or
  recovery execution.
- Stop before storing raw provider payloads or credential material.
