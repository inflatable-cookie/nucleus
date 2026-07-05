# 571 Accepted Memory Projection Payload Codec

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../130-accepted-memory-projection-file-materialization.md`

## Purpose

Define the deterministic sanitized file payload for accepted-memory projection.

## Work

- [x] Add a projected-memory payload type for `nucleus/memory/<memory-id>.toml`.
- [x] Encode stable id, scope, kind, status, title, sanitized summary/detail,
  source refs, sensitivity, retention, review evidence, supersession refs, and
  timestamps where available.
- [x] Exclude raw transcripts, provider payloads, terminal streams, private
  notes, credentials, secret values, and provider-native memory state.
- [x] Add TOML encode/decode tests for deterministic output and unsupported
  schema handling.

## Acceptance Criteria

- [x] Codec tests round-trip the projected payload.
- [x] Tests prove disallowed raw/private fields are absent.
- [x] The codec is pure and does not read or write files.
- [x] The projected schema is small, stable, and versioned.

## Result

Accepted-memory projection payloads now encode a small versioned TOML record
for `nucleus/memory/<memory-id>.toml`.

The codec is pure and rejects unsupported storage/projection schemas. Tests
prove projected files preserve sanitized memory context and exclude raw
transcripts, provider payloads, terminal streams, private notes, credentials,
secret values, and provider-native memory state.
