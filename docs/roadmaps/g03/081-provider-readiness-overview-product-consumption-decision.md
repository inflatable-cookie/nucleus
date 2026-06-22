# 081 Provider Readiness Overview Product Consumption Decision

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Choose how Provider Readiness Overview should be consumed next now that the
server, serialized envelope, `nucleusd`, Effigy, and Tauri IPC paths are
available.

This lane prevents accidental UI drift by deciding the next surface before any
visible panel work.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/077-provider-readiness-overview-projection.md`
- `docs/roadmaps/g03/078-provider-readiness-overview-query-control.md`
- `docs/roadmaps/g03/079-provider-readiness-overview-nucleusd-query.md`
- `docs/roadmaps/g03/080-provider-readiness-overview-tauri-ipc-consumption.md`

## Goals

- [x] Compare product consumption options.
- [x] Define any contract delta before visible UI.
- [x] Select one next lane.
- [x] Keep live provider reads and provider effects out of scope.

## Execution Plan

- [x] Review implemented evidence.
- [x] Compare consumption options.
- [x] Record the visible-surface contract delta.
- [x] Select the next lane and update the runway.

## Decision

The next product lane is a read-only desktop proof surface for Provider
Readiness Overview.

This is the smallest useful visible consumption step because the server
projection, query/control integration, serialized DTO, `nucleusd`, Effigy, and
Tauri IPC command adapter are already proven. A proof surface can validate the
client-facing shape without adding provider reads, provider writes, or extra
read-family fan-out.

The surface should render:

- readiness status
- supported and represented read-family counts
- missing evidence family count
- blocker and evidence counts
- sanitized provider, repo, and remote refs when present
- explicit no-effect flags

It should offer only read-only drilldowns to already-proven surfaces, such as
provider read-intent projection. Refresh, credential repair, provider writes,
task mutation, and live-provider actions stay blocked.

## Options Reviewed

- Desktop proof surface: selected. It proves visible product consumption
  without changing authority.
- Diagnostics-only expansion: deferred. `nucleusd`, Effigy, and IPC already
  inspect the surface; another diagnostics route adds less product value.
- More read-family fan-out: deferred. Issues, comments, reviews, and
  status/check refreshes should wait until the current overview is visible.
- Provider-effect admission: deferred. The overview still needs to help users
  understand readiness before any live provider authority expands.

## Surface Contract Delta

Contract `027` now permits a visible read-only overview surface over the
serialized DTO. Clients may display sanitized refs, counts, readiness status,
family names, and no-effect flags. Clients may not trigger live refresh,
credential resolution, provider network calls, provider writes, callback,
interruption, recovery execution, task mutation, or raw payload display from
this surface.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/304-provider-readiness-overview-product-consumption-options.md`
- `batch-cards/305-provider-readiness-overview-surface-contract-delta.md`
- `batch-cards/306-provider-readiness-overview-next-lane-closeout.md`

## Acceptance Criteria

- [x] The next product lane is selected from implementation evidence.
- [x] Deferred options are explicit.
- [x] Any visible UI work has a read-only contract boundary.
- [x] No provider credential resolution, network call, mutation, callback,
  interruption, recovery execution, task mutation, or raw payload retention is
  added.

## Stop Conditions

- Stop before visible UI implementation.
- Stop before live provider reads.
- Stop before credential resolution.
- Stop before provider effects.

## Closeout

Provider Readiness Overview should move next into a read-only desktop proof
surface. The surface is allowed to render the serialized overview DTO and
read-only drilldowns only. Live refresh, credential resolution, provider
effects, task mutation, and raw payload display remain blocked.
