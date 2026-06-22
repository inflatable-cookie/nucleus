# 078 Provider Readiness Overview Query Control

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Expose Provider Readiness Overview through the server query/control boundary.

This lane composes the overview from local-store-backed provider read-intent
query results. It does not add visible UI, live provider reads, credential
resolution, provider effects, or additional read-family fan-out.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/077-provider-readiness-overview-projection.md`
- `docs/roadmaps/g03/073-provider-read-intent-serialized-control-envelope.md`
- `docs/roadmaps/g03/075-provider-read-intent-tauri-ipc-consumption.md`

## Goals

- [x] Add a read-only server query kind for Provider Readiness Overview.
- [x] Compose the overview from existing read-intent query results.
- [x] Add serialized response DTO support with sanitized refs/counts.
- [x] Route through the local control handler.
- [x] Keep visible UI and provider effects blocked.

## Execution Plan

- [x] Define query/result vocabulary.
- [x] Compose from local-store-backed read-intent query results.
- [x] Add control-envelope response DTO.
- [x] Add focused handler and serialization tests.
- [x] Validate the server crate and docs.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/293-provider-readiness-overview-query-vocabulary.md`
- `batch-cards/294-provider-readiness-overview-handler-route.md`
- `batch-cards/295-provider-readiness-overview-response-dto.md`
- `batch-cards/296-provider-readiness-overview-query-control-validation-closeout.md`

## Acceptance Criteria

- [x] Server query can request Provider Readiness Overview.
- [x] Handler composes from existing local-store read-intent evidence.
- [x] DTO exposes readiness status, family counts, blocker counts, evidence
  counts, sanitized refs, and no-effect flags.
- [x] DTO omits credential material and raw provider payloads.
- [x] Focused tests pass.

## Stop Conditions

- Stop before visible UI.
- Stop before live provider reads.
- Stop before credential resolution.
- Stop before provider network calls or provider effects.

## Closeout

Provider Readiness Overview now has read-only query/control integration. The
server control API can request it separately from raw provider read-intent,
the local handler composes it from persisted read-intent evidence, and the
serialized response DTO exposes only sanitized refs/counts and no-effect flags.
