# 102 Provider Live Read Smoke Evidence Readiness Integration

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Fold persisted approved live-read smoke evidence into provider readiness
diagnostics without turning it into a provider refresh.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/100-provider-live-read-smoke-evidence-state-backed-query.md`
- `docs/roadmaps/g03/101-provider-live-read-smoke-evidence-seed-replay.md`

## Goals

- [x] Add a read-only source-count path for approved smoke evidence.
- [x] Decide whether it belongs in readiness overview, read-intent drilldown,
  or a separate live-read evidence panel.
- [x] Avoid treating one smoke read as general provider readiness.

## Execution Plan

- [x] Audit current readiness/read-intent DTO boundaries.
- [x] Add only source counts and no-effect flags where contract-safe.
- [x] Validate serialized DTO behavior and CLI rendering.
- [x] Stop before visible UI changes unless a later roadmap grants them.

## Batch Cards

Completed cards:

- `batch-cards/405-provider-live-read-smoke-evidence-readiness-audit.md`
- `batch-cards/406-provider-live-read-smoke-evidence-source-counts.md`
- `batch-cards/407-provider-live-read-smoke-evidence-readiness-dto-tests.md`
- `batch-cards/408-provider-live-read-smoke-evidence-readiness-validation.md`

## Acceptance Criteria

- [x] Readiness surfaces can acknowledge persisted smoke evidence safely.
- [x] No raw provider data or credential material is exposed.
- [x] No live provider read is triggered.

## Current Slice

Completed:

- added `approved_live_read_smoke_evidence_count` to provider readiness
  overview and serialized DTOs.
- kept readiness status and supported-family math based on stopped read-intent
  families, not the one approved live-read smoke.
- `nucleusd query provider-readiness-overview` now renders the count as a
  live-read source count.
