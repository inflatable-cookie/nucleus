# 079 Provider Readiness Overview Nucleusd Query

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Expose Provider Readiness Overview through `nucleusd` and root Effigy tasks.

This lane gives operators a stable non-UI inspection path for the readiness
overview before any visible panel work.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/077-provider-readiness-overview-projection.md`
- `docs/roadmaps/g03/078-provider-readiness-overview-query-control.md`

## Goals

- [x] Add `nucleusd query provider-readiness-overview`.
- [x] Render stable sanitized summary lines.
- [x] Expose a root Effigy selector.
- [x] Keep output read-only and effect-free.
- [x] Avoid visible UI expansion.

## Execution Plan

- [x] CLI query vocabulary.
- [x] Query routing and renderer.
- [x] Effigy task selector.
- [x] Focused tests and smoke command.
- [x] Validation and docs closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/297-provider-readiness-overview-nucleusd-query-vocabulary.md`
- `batch-cards/298-provider-readiness-overview-nucleusd-renderer.md`
- `batch-cards/299-provider-readiness-overview-effigy-selector.md`
- `batch-cards/300-provider-readiness-overview-nucleusd-validation-closeout.md`

## Acceptance Criteria

- [x] CLI parses `query provider-readiness-overview`.
- [x] Query routes to `ServerQueryKind::ProviderReadinessOverview`.
- [x] Output includes readiness status, family counts, blockers, evidence
  counts, and no-effect flags.
- [x] Output does not expose credential material or raw provider payloads.
- [x] Root Effigy selector runs from repo root.
- [x] Focused tests pass.

## Stop Conditions

- Stop before visible UI.
- Stop before live provider reads.
- Stop before credential resolution.
- Stop before provider effects.

## Closeout

`nucleusd query provider-readiness-overview` now routes through the read-only
Provider Readiness Overview server query and renders sanitized summary lines.
`effigy server:query:provider-readiness-overview` exposes the same inspection
path from repo root. The output includes readiness status, family counts,
blocker/evidence counts, and explicit no-effect flags without credential
material or raw provider payloads.

The next lane is Tauri IPC consumption of the same serialized read-only
overview, still without visible UI or provider effects.
