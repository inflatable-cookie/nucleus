# 076 Provider Read-Intent Product Consumption Decision

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Decide the first product consumption direction for provider read-intent after
the CLI, Effigy, serialized DTO, and Tauri IPC transport proofs.

This milestone prevents drift into speculative UI, more read-family fan-out, or
provider effects.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/068-provider-forge-read-pattern-consolidation.md`
- `docs/roadmaps/g03/069-provider-read-intent-projection-control.md`
- `docs/roadmaps/g03/075-provider-read-intent-tauri-ipc-consumption.md`

## Decision

The next product consumption surface is a server-owned Provider Readiness
Overview projection.

It should compose existing provider read-intent evidence into a client-safe
overview that answers:

- what provider context exists
- which read families are represented
- what is blocked or missing
- whether the provider surface is ready, repairable, unknown, or unsupported
- whether any provider effect occurred

It should not begin as visible UI. Desktop can consume it later through the
existing Tauri IPC boundary.

## Rejected For Now

- Visible desktop provider panel first.
- More read-family fan-out for issues, comments, reviews, or statuses.
- Live provider reads.
- Provider credential resolution.
- Forge writes.
- Task mutation from provider readiness.

## Goals

- [x] Choose one product direction.
- [x] Keep the direction server-first and client-safe.
- [x] Preserve no-effect provider boundaries.
- [x] Record the next implementation lane.

## Execution Plan

- [x] Compare available consumption surfaces.
- [x] Promote the decision into the provider auth/forge contract.
- [x] Compile the next server projection runway.
- [x] Keep visible UI paused.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/285-provider-read-intent-consumption-options.md`
- `batch-cards/286-provider-readiness-overview-contract-delta.md`
- `batch-cards/287-provider-readiness-overview-runway-selection.md`
- `batch-cards/288-provider-consumption-decision-validation-closeout.md`

## Acceptance Criteria

- [x] The next surface is selected.
- [x] The selection is represented in a contract.
- [x] The next implementation lane has bounded acceptance criteria.
- [x] The lane does not grant provider effects.

## Closeout

Provider read-intent should now move into a Provider Readiness Overview
projection. This keeps the system moving toward product usefulness while
staying server-first, client-safe, and effect-gated.
