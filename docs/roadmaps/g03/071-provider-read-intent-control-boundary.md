# 071 Provider Read-Intent Control Boundary

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Expose the generic provider read-intent query through the in-process server
control boundary without adding provider writes or prematurely defining the
wire DTO shape.

This lane makes local control handlers able to request the aggregate
read-intent projection. Serializable envelope support remains blocked until
the provider read-intent DTO contract is deliberately designed.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/069-provider-read-intent-projection-control.md`
- `docs/roadmaps/g03/070-provider-read-intent-query-composition.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`

## Goals

- [x] Add a transport-neutral provider read-intent query vocabulary to the
  server control API.
- [x] Route the query through `LocalControlRequestHandler`.
- [x] Return the existing read-only query result without provider effects.
- [x] Keep serializable envelope support explicitly unsupported until a wire
  DTO contract exists.
- [x] Add focused handler coverage.

## Execution Plan

- [x] Control query vocabulary.
- [x] Handler route.
- [x] Handler test.
- [x] Validation and docs closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/266-provider-read-intent-control-query-vocabulary.md`
- `batch-cards/267-provider-read-intent-control-handler-route.md`
- `batch-cards/268-provider-read-intent-control-boundary-tests.md`
- `batch-cards/269-provider-read-intent-control-boundary-validation-closeout.md`

## Acceptance Criteria

- [x] `ServerQueryKind` can represent provider read-intent projection queries.
- [x] `LocalControlRequestHandler` routes provider read-intent queries to the
  local-store backed query composition.
- [x] Empty local store returns an empty projection through the control
  handler.
- [x] Query path performs no credential resolution, provider network call,
  provider effect, callback, interruption, recovery execution, task mutation,
  or raw provider payload retention.
- [x] Serializable envelope conversion rejects provider read-intent results
  until the DTO shape is planned.
- [x] Focused tests pass.

## Closeout

`nucleus-server` now exposes provider read-intent projection through the
in-process control handler.

The new boundary adds:

- `ProviderReadIntentQuery`
- `ServerQueryKind::ProviderReadIntent`
- `ServerQueryResult::ProviderReadIntent`
- `LocalControlRequestHandler` query routing
- focused handler coverage for the no-effect empty projection path

The serializable envelope does not yet expose this query. It returns an
unsupported codec error for provider read-intent results so the future wire
contract is not accidentally set by an internal Rust shape.

Next lane:

- rebaseline the provider-forge read-intent boundary before choosing the first
  serialized envelope DTO for provider read-intent queries
