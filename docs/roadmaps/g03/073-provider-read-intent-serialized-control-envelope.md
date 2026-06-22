# 073 Provider Read-Intent Serialized Control Envelope

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Implement the first serialized provider read-intent control-envelope DTO as a
read-only query/result shape.

This lane makes provider read-intent projection available through the existing
control-envelope codec without granting provider writes, credential resolution,
or more read-family fan-out.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/069-provider-read-intent-projection-control.md`
- `docs/roadmaps/g03/070-provider-read-intent-query-composition.md`
- `docs/roadmaps/g03/071-provider-read-intent-control-boundary.md`
- `docs/roadmaps/g03/072-provider-read-intent-boundary-rebaseline.md`

## Goals

- [x] Add request DTO support for provider read-intent projection queries.
- [x] Add response DTO support for provider read-intent aggregate/source counts
  and sanitized entry refs.
- [x] Keep unsupported provider read-intent actions failing closed.
- [x] Keep response DTOs independent from internal Rust projection structs.
- [x] Prove no provider effect authority is granted by serialization.

## Execution Plan

- [x] Query DTO vocabulary.
- [x] Response DTO module and body variant.
- [x] Request/response codec tests.
- [x] Validation and docs closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/274-provider-read-intent-query-dto-vocabulary.md`
- `batch-cards/275-provider-read-intent-response-dto-module.md`
- `batch-cards/276-provider-read-intent-envelope-tests.md`
- `batch-cards/277-provider-read-intent-serialized-envelope-validation-closeout.md`

## Acceptance Criteria

- [x] Serialized request DTO can round-trip provider read-intent projection.
- [x] Unknown provider read-intent actions return unsupported codec errors.
- [x] Serialized response DTO exposes aggregate counts, source counts, and
  sanitized entry refs.
- [x] Serialized response DTO exposes explicit no-effect flags.
- [x] DTO path does not expose credential material, raw provider payloads, raw
  request/response bodies, or provider-native auth material.
- [x] Focused control-envelope tests pass.

## Closeout

The control-envelope codec now supports provider read-intent projection as a
read-only query/result shape.

The response DTO is in a focused `provider_read_intent` module and maps
internal projection records into explicit wire fields:

- aggregate counts
- source counts
- sanitized entry ids and refs
- string family/status/provider/action values
- explicit no-effect flags

Unsupported provider read-intent request actions still fail closed. The lane
does not add issue/comment/review/status read-family fan-out or any provider
write authority.

Next lane:

- expose provider read-intent through a thin `nucleusd` query command or pause
  for a control-client consumption decision if CLI surface is not desired
