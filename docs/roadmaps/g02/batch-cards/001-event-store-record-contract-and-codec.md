# 001 Event Store Record Contract And Codec

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the first stable event-store record envelope and codec for
orchestration events.

## Scope

- Event id.
- Stream ref.
- Sequence or cursor field.
- Command id causality.
- Event kind.
- Aggregate or workflow target ref.
- Payload schema version.
- Encoded payload boundary.
- Codec tests for accepted command-admission events.

## Out Of Scope

- Provider runtime events.
- SCM events.
- Remote transport.
- Snapshot cadence.
- Database migrations.

## Promotion Targets

- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `crates/nucleus-orchestration`

## Acceptance Criteria

- [x] The event-store envelope has explicit identity, stream, sequence/cursor, and
  schema-version fields.
- [x] Codec tests cover successful encode/decode and malformed payload rejection.
- [x] Request-handler code can use the envelope without knowing server storage
  record internals.

## Stop Conditions

- The codec starts encoding raw provider transcripts, terminal streams, or
  secret-bearing payloads.

## Outcome

- Added `OrchestrationEventStoreRecord` with stream ref, cursor, command
  causality, payload schema version, projection cursor, and typed payload.
- Added encode/decode validation that rejects malformed JSON and envelope /
  payload mismatches.
- Updated task command-admission event append and projection rebuild to use the
  event-store envelope.
